# Message request flow

Source capture: `202609200937-network.md`

## Overview

The application creates a conversation before sending the message. It generates a client request UUID, sends the initial message to `chat.data`, receives a conversation ID, navigates to that conversation, and then streams the model response from the conversation-specific `send-message` endpoint.

## Sequence

1. The browser is initially at `/chat`.
2. The client generates a `clientCreateRequestId`:

   `5aa0c93d-cee4-464b-8f27-5ce1b90ec407`

3. The client creates the conversation with:

   `POST https://de.aipass.net/chat.data`

   The captured request body is:

   ```text
   message=create+a+simple+hello+world+in+nodejs&folderId=&modelId=gemini-3.1-flash-lite&intent=create-conversation&clientCreateRequestId=5aa0c93d-cee4-464b-8f27-5ce1b90ec407
   ```

4. The `chat.data` response returns the conversation data:

   ```text
   conversationId = 5aa0c93dcee4464b
   initialMessage = create a simple hello world in nodejs
   clientCreateRequestId = 5aa0c93d-cee4-464b-8f27-5ce1b90ec407
   ```

5. The conversation ID is the first 16 hexadecimal characters of the client request UUID after removing hyphens:

   ```text
   5aa0c93d-cee4-464b-...
   -> 5aa0c93dcee4464b
   ```

6. The browser uses the returned ID in the conversation route:

   `https://de.aipass.net/chat/5aa0c93dcee4464b`

7. The client sends the message to the conversation-specific endpoint:

   `POST https://de.aipass.net/actions/send-message/5aa0c93dcee4464b`

   The captured request body contains:

   ```json
   {
     "modelId": "gemini-3.1-flash-lite",
     "messages": [
       {
         "id": "08ad6715-5168-4b74-908b-493195bd37ff",
         "role": "user",
         "metadata": {
           "modelId": "gemini-3.1-flash-lite"
         },
         "parts": [
           {
             "type": "text",
             "text": "create a simple hello world in nodejs"
           }
         ]
       }
     ]
   }
   ```

8. The `send-message` response is a streamed response. It begins with a keep-alive line and then emits server-sent event-style records:

   ```text
   data: {"type":"start", ...}
   data: {"type":"start-step"}
   data: {"type":"text-start","id":"0"}
   data: {"type":"text-delta","id":"0","delta":"..."}
   data: {"type":"text-end","id":"0"}
   data: {"type":"finish-step"}
   data: {"type":"finish", ...}
   data: [DONE]
   ```

9. The client polls `get-conversation-title.data` using the same conversation ID. The title changes from `New Conversation` to `Nodejs Hello World Tutorial`.

## Important identifiers

| Identifier | Value | Purpose |
|---|---|---|
| `clientCreateRequestId` | `5aa0c93d-cee4-464b-8f27-5ce1b90ec407` | Client-generated UUID used during conversation creation |
| `conversationId` | `5aa0c93dcee4464b` | Conversation route and `send-message` path identifier |
| Message ID | `08ad6715-5168-4b74-908b-493195bd37ff` | ID of the user message inside the `messages` array |
| Model | `gemini-3.1-flash-lite` | Model selected for the request |

## Conclusion

Response 111 did not generate the conversation ID. The ID was established during the earlier conversation-creation request and response. The later message request reused it as a URL path segment, allowing the server to associate the streamed model response with the correct conversation.
