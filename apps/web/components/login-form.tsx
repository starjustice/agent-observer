"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hardNavigate } from "@/lib/nav";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 204) {
        hardNavigate("/");
        return;
      }
      if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
        const minutes = Math.max(1, Math.ceil((body?.retryAfterSeconds ?? 900) / 60));
        setError(`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      } else if (res.status === 401) {
        setError("Wrong password.");
      } else {
        setError("The hub did not answer. Check that the API is running.");
      }
    } catch {
      setError("The hub did not answer. Check that the API is running.");
    }
    setBusy(false);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 shadow-lg"
    >
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <span className="size-2 rounded-full bg-violet" aria-hidden />
          Agent Observatory
        </h1>
        <p className="text-sm text-muted-foreground">Enter the viewer password to continue.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="h-10"
        />
        {error ? (
          <p id="login-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" className="h-10 w-full" disabled={busy || password.length === 0}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
