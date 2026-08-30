import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

const loadEnvFile = (): void => {
    const candidates = [".env.local", ".env"];

    for (const fileName of candidates) {
        const resolved = path.resolve(process.cwd(), fileName);
        if (!existsSync(resolved)) {
            continue;
        }

        const content = readFileSync(resolved, "utf8");
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                continue;
            }

            const equalsIndex = trimmed.indexOf("=");
            if (equalsIndex === -1) {
                continue;
            }

            const key = trimmed.slice(0, equalsIndex).trim();
            const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");

            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    }
};

loadEnvFile();

export const redis = Redis.fromEnv();
