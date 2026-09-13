import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    message: 'Hello from the App Router route handler',
    requestId: randomUUID(),
  });
}
