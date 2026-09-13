export const dynamic = 'force-dynamic';

async function getGreeting() {
  const port = process.env.PORT ?? '3000';
  const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`/api/hello responded with ${res.status}`);
  }
  return res.json() as Promise<{ message: string; requestId: string }>;
}

export default async function Home() {
  const data = await getGreeting();

  return (
    <div>
      <h1>Next.js on ECS Fargate + OpenTelemetry + AWS X-Ray</h1>
      <p>
        This page is a Server Component that calls <code>/api/hello</code> over HTTP on every
        request. The outbound fetch and the inbound API request are both auto-instrumented by
        OpenTelemetry (no OTel code in this app) and exported to AWS X-Ray via an ADOT Collector
        sidecar, so you should see a two-hop trace for each page load.
      </p>
      <p>
        Response from <code>/api/hello</code>: <strong>{data.message}</strong>
      </p>
      <p>
        Request ID: <code>{data.requestId}</code>
      </p>
    </div>
  );
}
