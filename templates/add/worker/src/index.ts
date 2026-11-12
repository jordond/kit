export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(`{{worker}}: ${new URL(request.url).pathname}`)
  },
}
