INSERT OR REPLACE INTO characters
(id, name, avatar_url, system_prompt, output_protocol_prompt, default_model, created_at)
VALUES
(
  'hara',
  'Hara',
  '',
  'SYSTEM_PROMPT_HERE',
  'OUTPUT_PROTOCOL_PROMPT_HERE',
  'gemma-4-31b',
  strftime('%s','now')
);