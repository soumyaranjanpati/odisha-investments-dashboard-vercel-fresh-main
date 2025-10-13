import './globals.css';
import React from 'react';

export const metadata = {
  title: 'India Investments Dashboard',
  description: 'Live, stateless dashboard for recent investment announcements'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
