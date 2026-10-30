// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccountMenu from './AccountMenu';

function makeProps() {
  return {
    apiBase: 'https://api.example',
    locale: 'en' as const,
    adminLabel: 'Admin',
    signInLabel: 'Sign in with GitHub',
    signInGiteeLabel: 'Sign in with Gitee',
    signOutLabel: 'Sign out',
    menuLabel: 'Account menu',
    myLabel: 'My jobs',
    claimedLabel: 'My profile',
    recruiterBadgeLabel: 'Recruiter',
    declareLabel: 'I am a recruiter',
    declareConfirm: 'declare?',
    revokeLabel: 'Revoke recruiter',
    revokeConfirm: 'revoke?',
    actionFailedLabel: 'Action failed',
  };
}

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an aria-busy placeholder before auth/me resolves', () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {}));
    render(<AccountMenu {...makeProps()} />);
    const loading = screen.getByTestId('account-menu-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
  });

  it('renders sign-in links for an anonymous user', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/auth/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ kind: 'anonymous' }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          github: { configured: true },
          gitee: { configured: false },
        }),
      });
    });
    render(<AccountMenu {...makeProps()} />);
    await waitFor(() => {
      expect(screen.getByTestId('signin-github')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('signin-gitee')).not.toBeInTheDocument();
  });
});
