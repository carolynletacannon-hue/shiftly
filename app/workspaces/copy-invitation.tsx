"use client";
import { Button } from "@/app/ui/button";
import { useEffect, useRef, useState } from "react";

export function CopyInvitation({ link }: { link: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (input.current) input.current.value = new URL(link, window.location.origin).toString();
  }, [link]);
  async function copy() {
    const absolute = new URL(link, window.location.origin).toString();
    if (input.current) input.current.value = absolute;
    try {
      await navigator.clipboard.writeText(absolute);
      setMessage("Invitation link copied.");
    } catch {
      input.current?.select();
      setMessage("Select and copy the invitation link manually.");
    }
  }
  return <div>
    <label>Copy this invitation link now (shown for two minutes)
      <input ref={input} readOnly defaultValue={link} aria-label="Invitation link" />
    </label>
    <Button icon="copy" type="button" className="button secondary" onClick={copy}>Copy invitation link</Button>
    <p role="status">{message}</p>
  </div>;
}
