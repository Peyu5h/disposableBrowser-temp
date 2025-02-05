'use client';

import dynamic from 'next/dynamic';

// Dynamically import the DisposableBrowser component
const DisposableBrowser = dynamic(() => import('./DisposableBrowser'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-gray-900"></div>
    </div>
  ),
});

export default function BrowserWrapper() {
  return <DisposableBrowser />;
}
