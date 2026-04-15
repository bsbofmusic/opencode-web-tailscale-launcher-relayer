"use strict"

const { text } = require("../http")

function serveStatic(ctx, res) {
  if (ctx.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" })
    res.end()
    return
  }
  if (ctx.pathname === "/site.webmanifest") {
    text(
      res,
      200,
      JSON.stringify({
        name: "OpenCode",
        short_name: "OpenCode",
        display: "standalone",
        start_url: "/",
        background_color: "#08111d",
        theme_color: "#08111d",
        icons: [],
      }),
      "application/manifest+json",
    )
    return
  }
}

module.exports = { serveStatic }
