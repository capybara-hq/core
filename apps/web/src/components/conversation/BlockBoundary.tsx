"use client";

import { LoadFailed } from "@capybara-hq/design";
import { Component, Fragment, type ReactNode } from "react";

/**
 * An extension block's own error boundary (spec §5.3): a block that throws while rendering shows
 * "Failed to load · Retry" in its place; the thread and the composer keep working.
 */
export class BlockBoundary extends Component<
  { name: string; children?: ReactNode },
  { failed: boolean; attempt: number }
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <LoadFailed
          name={this.props.name}
          onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
        />
      );
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
