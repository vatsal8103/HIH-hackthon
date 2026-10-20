import { Component, type ReactNode } from "react";

import { href } from "../hooks";

interface State {
  error: Error | null;
}

/**
 * Catches a rendering failure inside one page so the rest of the app (navigation, run
 * controller) keeps working. Keyed by route in App, so navigating away resets it.
 */
export class RouteBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Page failed to render:", error); // keep the real error visible in the console
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="max-w-2xl space-y-5 py-10">
        <p className="label text-rust-300">This page failed to render</p>
        <p className="font-serif text-[36px] leading-tight text-bone-50">Something went wrong on this page.</p>
        <p className="text-[14px] leading-relaxed text-bone-400">
          The rest of Bayora still works, and no data was changed. Try again, or go back to the overview.
        </p>
        <p className="border-l-2 border-rust-400 pl-4 font-mono text-[12px] text-rust-300">{error.message}</p>
        {import.meta.env.DEV && error.stack && (
          <pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-bone-500">{error.stack}</pre>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <a href={href()} className="btn">
            Go to the overview
          </a>
        </div>
      </div>
    );
  }
}
