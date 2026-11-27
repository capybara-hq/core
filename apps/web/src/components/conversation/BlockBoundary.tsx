"use client";

import { LoadFailed } from "@capybara-hq/design";
import { Component, Fragment, type ReactNode } from "react";

/**
 * An extension block's own error boundary (spec §5.3): a block that throws while rendering shows
 * "Failed to load · Retry" in its place; the thread and the composer keep working. `onError`
 * hears each catch (a client component's crash report, client extensions spec §10.3).
 * `failedFrame` draws the failure line inside a frame (a full plugin page: the host's page).
 */
export class BlockBoundary extends Component<
  {
    name: string;
    onError?(error: unknown): void;
    failedFrame?: (body: ReactNode) => ReactNode;
    children?: ReactNode;
  },
  { failed: boolean; attempt: number }
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      const line = (
        <LoadFailed
          name={this.props.name}
          onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
        />
      );
      return this.props.failedFrame ? this.props.failedFrame(line) : line;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
