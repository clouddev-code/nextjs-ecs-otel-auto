import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Next.js on ECS with OTel + X-Ray',
  description: 'Sample App Router app auto-instrumented with OpenTelemetry, traced via AWS X-Ray',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ display: 'flex', gap: '1rem', padding: '1rem', borderBottom: '1px solid #ddd' }}>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/api/hello">API: /api/hello</a>
        </nav>
        <main style={{ padding: '1.5rem' }}>{children}</main>
      </body>
    </html>
  );
}
