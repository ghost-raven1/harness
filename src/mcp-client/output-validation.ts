import {
  ErrorCode,
  McpError,
  type CompatibilityCallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  JsonSchemaType,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';

/** Сохраняет проверку результата независимо от смены страницы каталога в SDK. */
export function toolOutputValidator(tool: Tool, provider: jsonSchemaValidator) {
  if (!tool.outputSchema) return;
  const validate = provider.getValidator(tool.outputSchema as JsonSchemaType);
  return (result: CompatibilityCallToolResult): void => {
    if (!result.structuredContent) {
      if (!result.isError)
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Инструмент ' + tool.name + ' не вернул обязательный структурированный результат',
        );
      return;
    }
    const validation = validate(result.structuredContent);
    if (!validation.valid)
      throw new McpError(
        ErrorCode.InvalidParams,
        'Результат инструмента ' +
          tool.name +
          ' не соответствует схеме: ' +
          validation.errorMessage,
      );
  };
}
