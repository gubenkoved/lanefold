import { Component, type ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  /** What failed, for the message ("This view"). */
  readonly label: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error?: Error;
}

/**
 * Keeps one failing view from blanking the whole webview: it shows what went wrong, with a way
 * to try again (the rest of Lanefold keeps working).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`[lanefold] ${this.props.label} failed:`, error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <EmptyState
        icon="error"
        title={`${this.props.label} ran into a problem`}
        description={error.message}
        actions={
          <button type="button" className={styles.retry} onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
        }
      />
    );
  }
}
