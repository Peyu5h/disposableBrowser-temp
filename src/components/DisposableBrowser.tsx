import React, { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RefreshCw, ArrowLeft, ArrowRight } from 'lucide-react';

const DisposableBrowser = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('https://www.google.com');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [clipboardText, setClipboardText] = useState<string>('');
  const scrollTimeout = useRef<NodeJS.Timeout>();
  const lastScrollTime = useRef<number>(0);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://disposablebrowser-backend.onrender.com';
  
  useEffect(() => {
    const initBrowser = async () => {
      try {
        // Create WebRTC peer connection
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        peerConnection.current = pc;

        // Handle incoming tracks
        pc.ontrack = (event) => {
          console.log('Received track:', event.track.kind);
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
            videoRef.current.play().catch(e => console.error('Error playing video:', e));
          }
        };

        // Handle connection state changes
        pc.onconnectionstatechange = () => {
          console.log('Connection state:', pc.connectionState);
          setIsConnected(pc.connectionState === 'connected');
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            console.log('New ICE candidate:', event.candidate);
          }
        };

        // Create and set local description
        const offer = await pc.createOffer({
          offerToReceiveVideo: true,
          offerToReceiveAudio: false
        });
        await pc.setLocalDescription(offer);
        
        // Send offer to server
        const response = await fetch(`${apiUrl}/offer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sdp: offer.sdp,
            type: offer.type
          })
        });

        if (!response.ok) {
          throw new Error('Failed to send offer');
        }

        const { sdp, type, session_id } = await response.json();
        setSessionId(session_id);

        // Set remote description
        await pc.setRemoteDescription(new RTCSessionDescription({ sdp, type }));
        
        console.log('WebRTC connection established');
        
      } catch (error) {
        console.error('Failed to initialize browser:', error);
        setError(error instanceof Error ? error.message : 'Unknown error');
      }
    };
    
    initBrowser();
    
    return () => {
      if (peerConnection.current) {
        peerConnection.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault();
      if (!sessionId) return;
      
      const now = Date.now();
      const timeDiff = now - lastScrollTime.current;
      lastScrollTime.current = now;
      
      // Detect if it's a trackpad or mouse wheel
      const isTrackpad = Math.abs(e.deltaY) < 50;
      
      // Adjust multiplier based on input device and time difference
      let multiplier = isTrackpad ? 8 : 3; // Increased trackpad sensitivity
      
      // If scrolling happens rapidly, increase the multiplier
      if (timeDiff < 100) {
        multiplier *= 1.5;
      }
      
      const deltaY = e.deltaY * multiplier;
      
      // Clear previous timeout
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
      
      // Debounce scroll events
      scrollTimeout.current = setTimeout(() => {
        fetch(`${apiUrl}/event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            session_id: sessionId,
            type: 'scroll',
            deltaY: deltaY,
            isTrackpad
          })
        }).catch(error => {
          console.error('Failed to send scroll event:', error);
        });
      }, 16); // ~60fps
    };

    video.addEventListener('wheel', handleWheelEvent, { passive: false });
    return () => {
      video.removeEventListener('wheel', handleWheelEvent);
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
    };
  }, [sessionId]);

  // Handle mouse events
  const handleMouseMove = async (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!sessionId || !videoRef.current) return;

    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'mouse',
          x: Math.round(x * (1280 / rect.width)),
          y: Math.round(y * (720 / rect.height))
        })
      });
    } catch (error) {
      console.error('Failed to send mouse event:', error);
    }
  };

  const handleClick = async (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!sessionId || !videoRef.current) return;

    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'mouse',
          x: Math.round(x * (1280 / rect.width)),
          y: Math.round(y * (720 / rect.height)),
          click: true,
          button: e.button, // 0 for left, 1 for middle, 2 for right
          clickCount: 1
        })
      });
    } catch (error) {
      console.error('Failed to send click event:', error);
    }
  };

  // Navigation functions
  const navigate = async (targetUrl: string) => {
    if (!sessionId) return;
    setIsLoading(true);
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'navigate',
          url: targetUrl
        })
      });
      setUrl(targetUrl);
    } catch (error) {
      console.error('Navigation failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = url.trim();

    // Check if it's a URL or search query
    const isUrl = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w- ./?%&=]*)?$/.test(input);
    
    if (isUrl) {
      // Add https if protocol is missing
      const urlWithProtocol = input.startsWith('http') ? input : `https://${input}`;
      await navigate(urlWithProtocol);
    } else {
      // Treat as search query
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(input)}`;
      await navigate(searchUrl);
    }
  };

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!sessionId) return;
    
    // Handle copy/paste
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c') {
        // Request clipboard data from virtual browser
        try {
          const response = await fetch(`${apiUrl}/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              type: 'clipboard',
              action: 'copy'
            })
          });
          const data = await response.json();
          if (data.text) {
            await navigator.clipboard.writeText(data.text);
          }
        } catch (error) {
          console.error('Failed to copy:', error);
        }
        return;
      }
      
      if (e.key === 'v') {
        try {
          const text = await navigator.clipboard.readText();
              await fetch(`${apiUrl}/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              type: 'clipboard',
              action: 'paste',
              text
            })
          });
        } catch (error) {
          console.error('Failed to paste:', error);
        }
        return;
      }
    }
    
    // Handle other keyboard events
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'keyboard',
          key: e.key,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          meta: e.metaKey
        })
      });
    } catch (error) {
      console.error('Failed to send keyboard event:', error);
    }
  };

  const handleKeyPress = async (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!sessionId) return;
    
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'keyboard',
          text: e.key
        })
      });
    } catch (error) {
      console.error('Failed to send keyboard event:', error);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent<HTMLVideoElement>) => {
    e.preventDefault();
    if (!sessionId || !videoRef.current) return;

    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    try {
      await fetch(`${apiUrl}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          type: 'mouse',
          x: Math.round(x * (1280 / rect.width)),
          y: Math.round(y * (720 / rect.height)),
          click: true,
          button: 2,
          clickCount: 1
        })
      });
    } catch (error) {
      console.error('Failed to send right-click event:', error);
    }
  };

  return (
    <Card className="w-screen h-screen flex flex-col bg-black overflow-hidden">
      {/* Navigation Bar */}
      <div className="p-2 border-b flex items-center space-x-2 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={async () => {
            await fetch(`${apiUrl}/event`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session_id: sessionId,
                type: 'navigate',
                action: 'back'
              })
            });
          }}
          className="w-8 h-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={async () => {
              await fetch(`${apiUrl}/event`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session_id: sessionId,
                type: 'navigate',
                action: 'forward'
              })
            });
          }}
          className="w-8 h-8"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(url)}
          className="w-8 h-8"
          disabled={isLoading}
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
        <form onSubmit={handleSubmit} className="flex-1">
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full"
            placeholder="Search Google or enter a URL"
          />
        </form>
      </div>

      {/* Browser Window */}
      <div className="flex-1 relative overflow-hidden">
       
        {error ? (
          <div className="flex items-center justify-center h-full text-red-500">
            {error}
          </div>
        ) : (
          <video 
            ref={videoRef}
            autoPlay 
            playsInline
            muted
            className="w-full h-full object-contain"
            onMouseMove={handleMouseMove}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            style={{
              visibility: isConnected ? 'visible' : 'hidden',
              backgroundColor: 'white',
              cursor: 'default'
            }}
            onKeyDown={handleKeyDown}
            onKeyPress={handleKeyPress}
            tabIndex={0}  
          />
        )}
        {!isConnected && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-white">Connecting...</div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default DisposableBrowser;


