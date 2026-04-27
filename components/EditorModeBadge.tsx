"use client";

import { useEffect, useState } from "react";

const EDITOR_TOKEN_KEY = "availability-editor-token";

function captureEditorTokenFromUrlOrSession(): string | null {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get("editor")?.trim();
  if (tokenFromUrl && tokenFromUrl.length > 0) {
    sessionStorage.setItem(EDITOR_TOKEN_KEY, tokenFromUrl);

    params.delete("editor");
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleanUrl);

    return tokenFromUrl;
  }

  const fromSession = sessionStorage.getItem(EDITOR_TOKEN_KEY)?.trim();
  return fromSession && fromSession.length > 0 ? fromSession : null;
}

export function EditorModeBadge() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    try {
      const token = captureEditorTokenFromUrlOrSession();
      setActive(!!token);
    } catch {
      setActive(false);
    }
  }, []);

  if (!active) return null;

  return (
    <div className="editor-mode-badge" role="status" aria-live="polite">
      Editor mode active
    </div>
  );
}
