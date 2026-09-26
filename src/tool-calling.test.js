import test from 'node:test';
import assert from 'node:assert/strict';
import { finalAnswerFromAction, initialConversationMessage } from './ollama-stub.js';

const writeFileTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write content to a file.',
    parameters: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_name', 'content'],
    },
  },
};

test('initial prompt includes write_file and the exact user request', () => {
  const prompt = initialConversationMessage({
    body: {
      messages: [
        { role: 'system', content: 'You are a tool-using assistant.' },
        { role: 'user', content: 'Test this harnesses, call write_file with file_name "hello.txt", content "hello"' },
      ],
      tools: [writeFileTool],
    },
  }, 'Test this harnesses, call write_file with file_name "hello.txt", content "hello"');

  assert.match(prompt, /generate_answer\( message \) \{ \}/);
  assert.match(prompt, /write_file\( file_name, content \) \{ \}/);
  assert.match(prompt, /Description: Write content to a file\./);
  assert.match(prompt, /- file_name \(string\): No description provided\./);
  assert.match(prompt, /- content \(string\): No description provided\./);
  assert.match(prompt, /Test this harnesses, call write_file with file_name "hello\.txt", content "hello"/);
});

test('generate_answer action returns only its message', () => {
  const actionResponse = `<action name="generate_answer">
  <rationale>The requested file was written.</rationale>
  <parameters><![CDATA[
  {"message":"Created hello.txt with content hello"}
  ]]></parameters>
</action>`;

  assert.equal(finalAnswerFromAction(actionResponse), 'Created hello.txt with content hello');
});

test('write_file action remains available for the caller to execute', () => {
  const actionResponse = `<action name="write_file">
  <rationale>The user requested a file.</rationale>
  <parameters><![CDATA[
  {"file_name":"hello.txt","content":"hello"}
  ]]></parameters>
</action>`;

  assert.equal(finalAnswerFromAction(actionResponse), actionResponse);
});
