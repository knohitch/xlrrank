import "reflect-metadata";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import helmet from "helmet";
import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";
import { AppModule } from "./app.module.js";
import { CsrfGuard } from "./common/guards/csrf.guard.js";
import { safeLoggableError } from "./common/error-redaction.js";

async function bootstrap() {
  const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
  dotenv.config({ path: envFile, quiet: true });
  const env = getEnv();
  const logger = createChildLogger("api");

  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    logger: false,
    rawBody: true,
  });

  app.setGlobalPrefix("api");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );

  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalGuards(new CsrfGuard(app.get(Reflector)));

  const port = env.API_PORT;
  await app.listen(port);
  logger.info(`API listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error("Failed to start API:", safeLoggableError(err));
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught API exception:", safeLoggableError(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled API rejection:", safeLoggableError(reason));
  process.exit(1);
});
