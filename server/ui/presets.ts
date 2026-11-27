export interface CustomCliPreset {
  id: string;
  name: string;
  command: string;
  defaultModel: string;
  promptMode: 'stdin' | 'arg';
  outputFormat: 'text' | 'ndjson';
  args: string;
  resumeArgs: string;
  listModelsArgs?: string;
}

export const CUSTOM_CLI_PRESETS: Record<string, CustomCliPreset> = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode CLI',
    command: 'opencode',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'ndjson',
    args: 'run --format json {{?model:-m}} {{model}} {{prompt}}',
    resumeArgs: 'run --format json {{?model:-m}} {{model}} --session {{sessionId}} {{prompt}}',
    listModelsArgs: 'models',
  },
  aider: {
    id: 'aider',
    name: 'Aider CLI',
    command: 'aider',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'text',
    args: '--yes-always --no-auto-commits {{?model:--model}} {{model}} --message {{prompt}}',
    resumeArgs: '--yes-always --no-auto-commits {{?model:--model}} {{model}} --restore-chat-history --message {{prompt}}',
  },
  qwen: {
    id: 'qwen-code',
    name: 'Qwen Code CLI',
    command: 'qwen',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'ndjson',
    args: '{{?model:--model}} {{model}} -p {{prompt}} --output-format stream-json',
    resumeArgs: '--resume {{sessionId}} {{?model:--model}} {{model}} -p {{prompt}} --output-format stream-json',
  },
  goose: {
    id: 'goose',
    name: 'Goose CLI',
    command: 'goose',
    defaultModel: 'default',
    promptMode: 'arg',
    outputFormat: 'text',
    args: 'run {{?model:--model}} {{model}} -t {{prompt}}',
    resumeArgs: 'run --resume {{?model:--model}} {{model}} -t {{prompt}}',
  },
};
