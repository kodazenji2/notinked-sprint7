import { randomBytes } from "crypto";
import { redis } from "./redisClient";

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const SESSION_PREFIX = "session:";

export interface Session {
    id: string;
    createdAt: string;
    lastUsed: string;
}

function generateSessionId(): string {
    return randomBytes(32).toString("hex");
}

function toSessionKey(sessionId: string): string {
    return `${SESSION_PREFIX}${sessionId}`;
}

export async function createSession(): Promise<Session> {
    const id = generateSessionId();
    const now = new Date().toISOString();
    const session: Session = {
        id,
        createdAt: now,
        lastUsed: now,
    };

    await redis.setex(toSessionKey(id), SESSION_TTL, JSON.stringify(session));
    return session;
}

export async function getOrCreateSession(sessionId?: string): Promise<Session> {
    if (sessionId && typeof sessionId === "string") {
        const key = toSessionKey(sessionId);
        const existing = await redis.get<Session | null>(key);
        if (existing) {
            const updated: Session = {
                ...existing,
                lastUsed: new Date().toISOString(),
            };
            await redis.setex(key, SESSION_TTL, JSON.stringify(updated));
            return updated;
        }
    }

    return createSession();
}

export async function validateSession(sessionId: string): Promise<Session | null> {
    if (!sessionId || typeof sessionId !== "string") {
        return null;
    }

    const key = toSessionKey(sessionId);
    const session = await redis.get<Session | null>(key);
    return session ?? null;
}
