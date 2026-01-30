export async function handler() {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    },
    body: `event: message
data: {"content":"mcp-servern är igång"}

`
  };
}
