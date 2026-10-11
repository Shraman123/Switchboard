# The official MCP reference server ("everything"), unmodified, served over
# Streamable HTTP. It stands in for a third-party server the team didn't write.
FROM node:22.20-alpine
RUN npm install -g @modelcontextprotocol/server-everything@2026.8.31 && npm cache clean --force
ENV PORT=8080 NODE_ENV=production
USER 1000:1000
EXPOSE 8080
CMD ["mcp-server-everything", "streamableHttp"]
