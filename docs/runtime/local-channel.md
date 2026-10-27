# Embedded Core channel

Thor's desktop launcher generates a fresh 32-byte capability for each owned Core process. It supplies `THOR_CORE_LOCAL_TOKEN` only to that child. Every local HTTP route, including health and assets, and every WebSocket upgrade requires `X-Thor-Local-Token`. Missing or malformed launch credentials fail startup. Local mode binds only to loopback.

The outer router boundary rejects Host values outside the loopback names with the actual bound port. Authenticated requests permit an absent Origin for native clients, the exact Core origin, or Electron's opaque `null` origin. Development can configure one exact HTTP loopback renderer origin through `THOR_CORE_TRUSTED_ORIGIN`. Other origins, malformed or duplicated headers, wrong ports, and unauthenticated preflights fail before handlers run. Responses never advertise wildcard CORS.

Electron main injects the capability only for requests from the trusted application main frame to the current exact Core origin. It supplies the same header to its own native fetch callers and rejects redirects. The secret is not sent through renderer IPC or browser storage; preview guests do not receive it. Core captures the capability in private memory and removes it from its process environment before starting workers or spawning children. The runtime's cleaned agent environment and final subprocess builders also strip both local-channel variables.

Existing conversation-scoped helper endpoints retain their separate runtime-token or hook-token authentication. Native helper CLI calls to ordinary APIs must pass live conversation-helper scope verification bound to the local user and conversation, followed by the existing active-user authentication. Neither helper channel accepts a browser Origin or grants WebSocket access. Non-local WebUI authentication is unchanged.

The optional desktop-hosted WebUI proxy is disabled for this private local Core. Its old proxy has no separate browser authentication, so it cannot safely receive the desktop capability. Interactive and automatic startup both fail closed with guidance to use the desktop app or a separate authenticated Core in WebUI mode with its own data directory.

Headless callers of a local Core process must arrange the capability in their own process environment or in-memory client headers. Do not put it in command-line arguments, logs, feedback, checked-in files, or global agent configuration.
