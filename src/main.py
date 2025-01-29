from aiohttp import web
from aiohttp_cors import setup as cors_setup, ResourceOptions
import asyncio
import json
import logging
import uuid
from playwright.async_api import async_playwright
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack, VideoStreamTrack
import av
import fractions
import numpy as np
from PIL import Image
import io
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class BrowserVideoStreamTrack(VideoStreamTrack):
    def __init__(self, page):
        super().__init__()
        self.page = page
        self.start_time = time.time()
        self.fps = 30
        self.frame_count = 0
        logger.info("VideoStreamTrack initialized")

    async def recv(self):
        try:
            # Increment frame count
            self.frame_count += 1
            
            # Capture screenshot with specific dimensions
            screenshot = await self.page.screenshot(
                type='jpeg',
                quality=80,
                full_page=False,
                clip={
                    'x': 0,
                    'y': 0,
                    'width': 1280,
                    'height': 720
                }
            )
            
            # Convert to PIL Image
            image = Image.open(io.BytesIO(screenshot))
            
            # Ensure image is in RGB format and correct size
            if image.mode != 'RGB':
                image = image.convert('RGB')
            
            # Resize if needed
            if image.size != (1280, 720):
                image = image.resize((1280, 720), Image.Resampling.LANCZOS)
            
            # Convert to numpy array with correct shape
            numpy_image = np.array(image)
            
            # Create video frame with correct dimensions
            frame = av.VideoFrame.from_ndarray(
                numpy_image,
                format='rgb24'
            )
            
            # Set frame timing
            pts = int((time.time() - self.start_time) * self.fps * 1000)
            frame.time_base = fractions.Fraction(1, self.fps * 1000)
            frame.pts = pts
            
            if self.frame_count % 30 == 0:  # Log every 30 frames
                logger.info(f"Frame captured: {self.frame_count}, size: {numpy_image.shape}")
            
            # Small delay to maintain frame rate
            await asyncio.sleep(1/self.fps)
            
            return frame
            
        except Exception as e:
            logger.error(f"Error capturing frame: {e}")
            logger.exception(e)
            raise

    async def stop(self):
        logger.info("Stopping video track")
        await super().stop()

class BrowserStreamer:
    def __init__(self):
        self.sessions = {}
        self.playwright = None
        self.browser = None
        self.scroll_speeds = {}  # Store scroll speeds per session
        
    async def ensure_browser(self):
        try:
            if not self.playwright:
                logger.info("Starting Playwright")
                self.playwright = await async_playwright().start()
                logger.info("Launching browser")
                self.browser = await self.playwright.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--use-gl=egl',
                    ]
                )
                logger.info("Browser launched successfully")
            return self.browser
        except Exception as e:
            logger.error(f"Error in ensure_browser: {e}")
            logger.exception(e)
            raise

    async def create_browser(self):
        try:
            logger.info("Creating new browser session")
            browser = await self.ensure_browser()
            if not browser:
                raise Exception("Failed to create browser")
            
            logger.info("Creating browser context")
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                device_scale_factor=1,
                color_scheme='light',
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                bypass_csp=True,
            )
            
            logger.info("Creating new page")
            page = await context.new_page()
            
            # Set viewport size
            await page.set_viewport_size({'width': 1280, 'height': 720})
            
            # Block ads and trackers
            await page.route("**/(analytics|ads|google-analytics|doubleclick).*", lambda route: route.abort())
            
            # Bypass reCAPTCHA
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
            
            # Navigate to Google with specific parameters to avoid reCAPTCHA
            await page.goto('https://www.google.com/search?hl=en&gl=us&pws=0', 
                wait_until='networkidle')
            
            return {
                'context': context,
                'page': page
            }
            
        except Exception as e:
            logger.error(f"Error creating browser: {e}")
            logger.exception(e)
            if 'context' in locals():
                await context.close()
            raise

    async def handle_offer(self, request):
        try:
            logger.info("Handling WebRTC offer")
            data = await request.json()
            offer = RTCSessionDescription(
                sdp=data['sdp'],
                type=data['type']
            )
            
            pc = RTCPeerConnection()
            session_id = str(uuid.uuid4())
            logger.info(f"Created new session: {session_id}")
            
            @pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"Connection state changed to: {pc.connectionState}")
                if pc.connectionState == "failed":
                    await pc.close()
                    if session_id in self.sessions:
                        await self.cleanup_session(session_id)

            logger.info("Creating browser session")
            try:
                session = await self.create_browser()
                if not session:
                    raise Exception("Failed to create browser session")
                
                # Wait for page to be fully loaded
                await asyncio.sleep(1)
                
                self.sessions[session_id] = {
                    **session,
                    'pc': pc
                }
                
                logger.info("Creating video track")
                video_track = BrowserVideoStreamTrack(session['page'])
                pc.addTrack(video_track)
                
                logger.info("Setting WebRTC descriptions")
                await pc.setRemoteDescription(offer)
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                
                # Wait for ICE gathering
                await asyncio.sleep(1)
                
                logger.info(f"Session created successfully: {session_id}")
                return web.json_response({
                    'sdp': pc.localDescription.sdp,
                    'type': pc.localDescription.type,
                    'session_id': session_id
                })
            except Exception as e:
                logger.error(f"Error in handle_offer: {e}")
                logger.exception(e)
                raise
                
        except Exception as e:
            logger.error(f"Error handling offer: {e}")
            logger.exception(e)
            return web.json_response(
                {'error': str(e)}, 
                status=500
            )

    async def handle_event(self, request):
        try:
            data = await request.json()
            session_id = data['session_id']
            
            if session_id not in self.sessions:
                return web.Response(status=404)
                
            session = self.sessions[session_id]
            page = session['page']
            
            if data['type'] == 'scroll':
                try:
                    # Get current scroll position
                    current_scroll = await page.evaluate('window.scrollY')
                    
                    # Calculate new scroll position
                    delta = data['deltaY']
                    is_trackpad = data.get('isTrackpad', False)
                    
                    # Dynamic scroll speed adjustment
                    if session_id not in self.scroll_speeds:
                        self.scroll_speeds[session_id] = {
                            'speed': 1.0,
                            'last_time': time.time(),
                            'consecutive_scrolls': 0
                        }
                    
                    scroll_data = self.scroll_speeds[session_id]
                    current_time = time.time()
                    time_diff = current_time - scroll_data['last_time']
                    
                    # Adjust scroll speed based on scroll frequency
                    if time_diff < 0.1:  # Rapid scrolling
                        scroll_data['consecutive_scrolls'] += 1
                        scroll_data['speed'] = min(2.5, scroll_data['speed'] * 1.1)
                    else:
                        scroll_data['consecutive_scrolls'] = 0
                        scroll_data['speed'] = 1.0
                    
                    scroll_data['last_time'] = current_time
                    
                    # Calculate final scroll amount
                    base_speed = 2.0 if is_trackpad else 1.0
                    scroll_amount = delta * base_speed * scroll_data['speed']
                    new_scroll = current_scroll + scroll_amount
                    
                    # Use requestAnimationFrame for smoother scrolling
                    await page.evaluate(f'''
                        requestAnimationFrame(() => {{
                            window.scrollTo({{
                                top: {new_scroll},
                                behavior: {'"smooth"' if is_trackpad else '"auto"'}
                            }});
                        }});
                    ''')
                    
                except Exception as e:
                    logger.error(f"Scroll error: {e}")
            
            elif data['type'] == 'navigate':
                if 'url' in data:
                    await page.goto(data['url'], wait_until='networkidle')
                elif data.get('action') == 'back':
                    await page.go_back()
                elif data.get('action') == 'forward':
                    await page.go_forward()
            
            elif data['type'] == 'mouse':
                await page.mouse.move(data['x'], data['y'])
                if data.get('click'):
                    button = 'left'
                    if data.get('button') == 2:
                        button = 'right'
                    elif data.get('button') == 1:
                        button = 'middle'
                    await page.mouse.click(
                        data['x'], 
                        data['y'], 
                        button=button,
                        click_count=data.get('clickCount', 1)
                    )
            
            elif data['type'] == 'keyboard':
                modifiers = []
                if data.get('ctrl'):
                    modifiers.append('Control')
                if data.get('alt'):
                    modifiers.append('Alt')
                if data.get('shift'):
                    modifiers.append('Shift')
                if data.get('meta'):
                    modifiers.append('Meta')
                    
                if modifiers:
                    for modifier in modifiers:
                        await page.keyboard.down(modifier)
                        
                await page.keyboard.press(data['key'])
                
                if modifiers:
                    for modifier in modifiers:
                        await page.keyboard.up(modifier)
            
            elif data['type'] == 'clipboard':
                if data['action'] == 'copy':
                    # Get selected text from page
                    text = await page.evaluate('''() => {
                        return window.getSelection()?.toString() || '';
                    }''')
                    return web.json_response({'text': text})
                
                elif data['action'] == 'paste':
                    # Paste text into active element
                    text = data.get('text', '')
                    await page.keyboard.type(text)
            
            return web.Response(status=200)
            
        except Exception as e:
            logger.error(f"Error handling event: {e}")
            logger.exception(e)
            return web.json_response({'error': str(e)}, status=500)
   
    async def cleanup_session(self, session_id):
        if session_id in self.sessions:
            try:
                session = self.sessions[session_id]
                await session['context'].close()
                await session['pc'].close()
                del self.sessions[session_id]
                logger.info(f"Cleaned up session: {session_id}")
            except Exception as e:
                logger.error(f"Error cleaning up session: {e}")

    async def cleanup(self):
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()

async def init_app():
    app = web.Application()
    streamer = BrowserStreamer()
    app['streamer'] = streamer
    
    # Add cleanup
    async def cleanup(app):
        await app['streamer'].cleanup()
    app.on_cleanup.append(cleanup)
    
    # Add routes
    app.router.add_post('/offer', streamer.handle_offer)
    app.router.add_post('/event', streamer.handle_event)
    
    # Setup CORS
    cors = cors_setup(app, defaults={
        "*": ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods="*",
            max_age=3600
        )
    })
    
    # Add CORS to routes
    for route in list(app.router.routes()):
        cors.add(route)
    
    return app

if __name__ == '__main__':
    app = init_app()
    web.run_app(app, host='0.0.0.0', port=8080)