import * as vscode from 'vscode';

export type ResponsesInputMessage = {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
};

export function convertMessagesToResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputMessage[] {
  return messages
    .map((message) => {
      const content = getTextFromMessage(message);

      return {
        role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
        content
      } satisfies ResponsesInputMessage;
    })
    .filter((message) => message.content.trim().length > 0);
}

export function getTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
}
