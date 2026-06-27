import { readFileSync } from "node:fs";
import { z } from "zod";

// Zod mirror of config/targets.schema.json. The JSON Schema documents/editor-
// validates the file; this validates it at runtime and yields the Target type.

export const socialSchema = z
  .object({
    instagram: z.string().url().optional(),
    facebook: z.string().url().optional(),
    tiktok: z.string().url().optional(),
  })
  .strict();

export const webSchema = z
  .object({
    enabled: z.boolean(),
    url: z.string().url().optional(),
    source: z.enum(["apify", "firecrawl", "xml_feed"]).nullable().optional(),
    // Storefront platform — routes the right collector. Set in Phase 1 profiling.
    platform: z
      .enum(["woocommerce", "magento", "nopcommerce", "custom", "xml_feed"])
      .nullable()
      .optional(),
    feed_env: z.string().optional(),
    monobrand: z.boolean().optional().default(false),
    per_location_stock: z.boolean().nullable().optional(),
    locations: z.array(z.string()).optional().default([]),
  })
  .strict();

export const registrySchema = z
  .object({
    central_registry_id: z.string().nullable(),
  })
  .strict();

export const targetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    legal_entity: z.string(),
    is_self: z.boolean().optional().default(false),
    web: webSchema,
    social: socialSchema.optional().default({}),
    registry: registrySchema.optional(),
  })
  .strict();

export const targetsFileSchema = z
  .object({
    $schema: z.string().optional(),
    _note: z.string().optional(),
    targets: z.array(targetSchema).min(1),
  })
  .strict();

export type Social = z.infer<typeof socialSchema>;
export type Web = z.infer<typeof webSchema>;
export type Target = z.infer<typeof targetSchema>;

/** Load + validate config/targets.json. Throws a readable error on invalid config. */
export function loadTargets(path: string): Target[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = targetsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid targets config at ${path}:\n${details}`);
  }
  return parsed.data.targets;
}

/** Targets whose inventory feeds the depletion engine (web enabled). */
export function webTrackableTargets(targets: Target[]): Target[] {
  return targets.filter((t) => t.web.enabled);
}
