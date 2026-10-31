"use client";

import { Component, type ReactNode } from "react";

export class RecordBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-6">
        <p className="text-sm">This record can&apos;t be opened. Its link may be wrong, or it couldn&apos;t be read just now.</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={() => this.setState({ failed: false })} className="view-action">Try again</button>
          <button type="button" onClick={this.props.onClose} className="view-action">Close</button>
        </div>
      </div>
    );
  }
}
