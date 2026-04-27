"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MonthBoard } from "@/components/MonthBoard";
import { buildMonthBoard, type MonthBoardData } from "@/lib/view";
import { SnapshotSchema } from "@/lib/types";

interface Props {
  initialMonth: MonthBoardData;
  monthKey: string;
  timezone: string;
  todayKey: string;
}

const EDITOR_TOKEN_KEY = "availability-editor-token";

export function MonthBoardEditor({
  initialMonth,
  monthKey,
  timezone,
  todayKey,
}: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setMonth(initialMonth);
  }, [initialMonth]);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tokenFromUrl = params.get("editor")?.trim();
      if (tokenFromUrl && tokenFromUrl.length > 0) {
        sessionStorage.setItem(EDITOR_TOKEN_KEY, tokenFromUrl);
        setEditorToken(tokenFromUrl);

        params.delete("editor");
        const query = params.toString();
        const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", cleanUrl);
        return;
      }

      const fromSession = sessionStorage.getItem(EDITOR_TOKEN_KEY);
      if (fromSession && fromSession.trim().length > 0) {
        setEditorToken(fromSession.trim());
      }
    } catch {
      setEditorToken(null);
    }
  }, []);

  useEffect(() => {
    if (!modalDate) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        setModalDate(null);
        setFormError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalDate, isSaving]);

  const closeModal = () => {
    if (isSaving) return;
    setModalDate(null);
    setFormError(null);
  };

  const startCreate = (date: string) => {
    if (!editorToken) return;
    setModalDate(date);
    setTitle("");
    setNotes("");
    setFormError(null);
  };

  const saveGig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modalDate) return;
    if (!editorToken) {
      setFormError("Read-only mode");
      return;
    }

    const safeTitle = title.trim();
    if (!safeTitle) {
      setFormError("Job Title is required");
      return;
    }

    setIsSaving(true);
    setFormError(null);

    try {
      const res = await fetch("/api/gigs/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editorToken}`,
        },
        body: JSON.stringify({
          date: modalDate,
          title: safeTitle,
          ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
        }),
      });

      if (res.status === 409) {
        setFormError("Day already booked");
        return;
      }
      if (res.status === 401 || res.status === 403) {
        try {
          sessionStorage.removeItem(EDITOR_TOKEN_KEY);
        } catch {
          // ignore storage errors
        }
        setEditorToken(null);
        setFormError("Read-only mode");
        return;
      }
      if (!res.ok) {
        setFormError("Failed to create event");
        return;
      }

      const json: unknown = await res.json();
      const parsed = SnapshotSchema.safeParse(
        (json as { snapshot?: unknown })?.snapshot,
      );
      if (!parsed.success) {
        setFormError("Failed to create event");
        return;
      }

      const freshMonth = buildMonthBoard({
        snapshot: parsed.data,
        month: monthKey,
        timezone,
        todayKey,
      });
      setMonth(freshMonth);
      setModalDate(null);
      setTitle("");
      setNotes("");
      setFormError(null);
    } catch {
      setFormError("Failed to create event");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <section className="gig-editor" aria-label="Gig editor mode">
        <div className="gig-editor-state">
          <span className="gig-editor-text">{editorToken ? "Editor mode active" : "Read-only mode"}</span>
        </div>
      </section>

      <MonthBoard
        month={month}
        todayKey={todayKey}
        editorModeActive={!!editorToken}
        onAvailableDayClick={startCreate}
      />

      {modalDate ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={closeModal}
        >
          <section
            className="board-day-modal gig-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gig-create-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close"
              onClick={closeModal}
              disabled={isSaving}
            >
              ×
            </button>

            <h3 id="gig-create-title" className="board-day-modal-title">Create All-Day Gig</h3>
            <p className="gig-create-date">{modalDate}</p>

            <form className="gig-create-form" onSubmit={saveGig}>
              <label className="gig-create-field">
                <span>Job Title</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  disabled={isSaving}
                />
              </label>

              <label className="gig-create-field">
                <span>Notes</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={isSaving}
                  rows={3}
                />
              </label>

              {formError ? <p className="gig-create-error">{formError}</p> : null}

              <div className="gig-create-actions">
                <button type="button" className="gig-create-button" onClick={closeModal} disabled={isSaving}>
                  Cancel
                </button>
                <button type="submit" className="gig-create-button gig-create-button--primary" disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
