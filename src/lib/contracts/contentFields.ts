import { z } from 'zod';
export type ContentField = { kind: 'text' | 'longtext' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'reference'; label?: string; required?: boolean; options?: string[]; fields?: Record<string, ContentField>; items?: ContentField };
export const contentFieldSchema: z.ZodType<ContentField> = z.lazy(() => z.object({
  kind: z.enum(['text', 'longtext', 'number', 'boolean', 'enum', 'array', 'object', 'reference']),
  label: z.string().max(100).optional(), required: z.boolean().optional(),
  options: z.array(z.string().max(200)).min(1).max(100).optional(),
  fields: z.record(z.string(), contentFieldSchema).optional(), items: contentFieldSchema.optional(),
}).strict().superRefine((field, ctx) => {
  if ((field.kind === 'enum') !== (field.options !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only enum fields require options.' });
  if ((field.kind === 'array') !== (field.items !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only array fields require an item schema.' });
  if ((field.kind === 'object') !== (field.fields !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only object fields require a field schema.' });
}));
