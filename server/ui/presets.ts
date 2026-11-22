export interface CustomCliPreset {
  id: string;
  name: string;
  command: string;
  defaultModel: string;
  promptMode: 'stdin' | 'arg';
  outputFormat: 'text' | 'ndjson';
  args: string;
  resumeArgs: string;
}

export const CUSTOM_CLI_PRESETS: Record<string, CustomCliPreset> = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode CLI',
    command: 'opencode',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'ndjson',
    args: 'run --format json --model {{model}} {{prompt}}',
    resumeArgs: 'run --format json --session {{sessionId}} --model {{model}} {{prompt}}',
  },
  aider: {
    id: 'aider',
    name: 'Aider CLI',
    command: 'aider',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'text',
    args: '--yes-always --no-auto-commits --model {{model}} --message {{prompt}}',
    resumeArgs: '--yes-always --no-auto-commits --model {{model}} --message {{prompt}}',
  },
  qwen: {
    id: 'qwen-code',
    name: 'Qwen Code CLI',
    command: 'qwen',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'ndjson',
    args: '-p {{prompt}} --output-format stream-json',
    resumeArgs: '--resume {{sessionId}} -p {{prompt}} --output-format stream-json',
  },
  goose: {
    id: 'goose',
    name: 'Goose CLI',
    command: 'goose',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'text',
    args: 'run -t {{prompt}}',
    resumeArgs: 'run -t {{prompt}}',
  },
};
