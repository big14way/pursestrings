import { serve } from "@hono/node-server";
import { createDemoApp } from "./server.ts";

const port = Number(process.env.PORT ?? 8410);
const { app } = createDemoApp();
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => console.log(`PurseStrings demo on http://localhost:${info.port}`));
