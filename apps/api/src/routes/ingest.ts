import express, { Router, type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import {
  DEMO_HEADER,
  DEVICE_HEADER,
  DeviceNameSchema,
  MODEL_HEADER,
  MODEL_HEADER_PATTERN,
  type NormalizedAgentEvent,
} from '@ao/shared';
import { requireIngestToken } from '../auth';
import { normalizeClaudeEvent } from '../collectors/claude';
import { normalizeOpencodeEvent } from '../collectors/opencode';
import type { AppDeps } from '../app';
import { ingestEvent } from '../ingest/pipeline';

/**
 * Ingestion never returns a body. For Claude Code an empty 2xx means
 * "nothing to add": no decision, no context, no output.
 */
export function ingestRouter(deps: AppDeps): Router {
  const router = Router();
  const { config, db, hub, now } = deps;

  router.use(requireIngestToken(config));
  router.use((req, res, next) => {
    const device = DeviceNameSchema.safeParse(req.header(DEVICE_HEADER) ?? '');
    if (!device.success) {
      res.status(400).end();
      return;
    }
    res.locals.deviceName = device.data;
    res.locals.isDemo = ['1', 'true'].includes((req.header(DEMO_HEADER) ?? '').toLowerCase());
    next();
  });
  router.use(express.json({ limit: config.ingestMaxBodyBytes, type: () => true }));

  const collect = (name: string, normalize: (raw: unknown) => NormalizedAgentEvent | null) => {
    router.post(`/${name}`, (req, res) => {
      let event: NormalizedAgentEvent | null;
      try {
        event = normalize(req.body);
      } catch (error) {
        // Never log the payload: it may hold prompts or file contents.
        if (!(error instanceof ZodError)) console.error(`[ingest/${name}] normalize failed`);
        res.status(400).end();
        return;
      }
      // From here on the raw body is no longer referenced anywhere.
      if (event) {
        // Claude Code hook payloads do not carry the model, so the sender may
        // name it in a header. It describes the main agent only.
        const headerModel = req.header(MODEL_HEADER) ?? '';
        if (!event.model && event.role === 'main' && MODEL_HEADER_PATTERN.test(headerModel)) {
          event.model = headerModel;
        }
        try {
          const result = ingestEvent(db, event, {
            deviceName: res.locals.deviceName as string,
            isDemo: res.locals.isDemo as boolean,
            now: now(),
            extraRoots: config.extraRoots,
          });
          if (result.stored) hub.broadcast(result.message);
        } catch (error) {
          console.error(`[ingest/${name}] store failed:`, error instanceof Error ? error.message : 'unknown');
        }
      }
      res.status(204).end();
    });
  };
  const captureDetail = config.captureDetail;
  collect('claude', (raw) => normalizeClaudeEvent(raw, { captureDetail }));
  collect('opencode', (raw) => normalizeOpencodeEvent(raw, { captureDetail }));

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : 400).end();
  };
  router.use(onError);

  return router;
}
