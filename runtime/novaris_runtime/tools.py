"""Custom tools: web search through the backend, and asking the user a question."""

from __future__ import annotations

import logging

import httpx
from langchain_core.tools import BaseTool, tool

logger = logging.getLogger(__name__)

WEB_SEARCH_TIMEOUT_SECONDS = 20.0
ASK_USER_TOOL = "ask_user"


def make_web_search_tool(endpoint_url: str, install_token: str) -> BaseTool:
    @tool
    async def web_search(query: str, max_results: int = 5) -> str:
        """Search the web. Returns titles, URLs and short excerpts of the top results."""
        max_results = max(1, min(int(max_results), 10))
        try:
            async with httpx.AsyncClient(timeout=WEB_SEARCH_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    endpoint_url,
                    json={"query": query, "max_results": max_results},
                    headers={"Authorization": f"Bearer {install_token}"},
                )
            response.raise_for_status()
            results = response.json().get("data", {}).get("results", [])
        except httpx.HTTPStatusError as error:
            logger.warning("Web search failed", extra={"status": error.response.status_code})
            return f"Web search is unavailable right now (HTTP {error.response.status_code})."
        except httpx.HTTPError as error:
            logger.warning("Web search failed", extra={"error": str(error)})
            return "Web search is unavailable right now."

        if not results:
            return "No results found."
        return "\n\n".join(
            f"{i}. {r.get('title', '')}\n{r.get('url', '')}\n{r.get('content', '')}" for i, r in enumerate(results, 1)
        )

    return web_search


@tool(ASK_USER_TOOL)
def ask_user(question: str) -> str:
    """Ask the user a clarifying question and wait for their answer. Use it instead of guessing."""
    # Never runs: the HITL middleware interrupts this tool and returns the user's answer instead.
    return "The user did not answer."
