/** Формирует конфигурацию клиента с абсолютными путями, без ключей и запуска оболочки. */
export function clientConfiguration(
  client: string,
  node: string,
  cli: string,
  state: string,
): string {
  const args = [cli, '--state', state, 'mcp'];
  if (client === 'codex')
    return [
      '[mcp_servers.harness]',
      'command = ' + JSON.stringify(node),
      'args = ' + JSON.stringify(args),
      'enabled = true',
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 40',
      '',
    ].join('\n');
  if (client !== 'opencode') throw new Error('Клиент должен быть codex или opencode.');
  return (
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: { harness: { type: 'local', command: [node, ...args], enabled: true } },
      },
      null,
      2,
    ) + '\n'
  );
}
