// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClaimProfile from './ClaimProfile';

const props = {
  apiBase: 'https://api.example',
  profileId: 'prof-1',
  subjectPlatform: 'github' as const,
  subjectLogin: 'alice',
  ctaLabel: 'Claim this profile',
  claimingLabel: 'Claiming…',
  claimedBadge: 'Verified owner',
  errorLabel: 'Claim failed',
  hintLabel: 'Verify you own this account',
};

const userMe = {
  kind: 'user',
  platform: 'github',
  login: 'alice',
  claimedProfileId: null,
};

describe('ClaimProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for an anonymous viewer', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'anonymous' }),
    });
    const { container } = render(<ClaimProfile {...props} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the logged-in user is not the subject', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...userMe, login: 'bob' }),
    });
    const { container } = render(<ClaimProfile {...props} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the claimed badge when the user already owns the profile', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...userMe, claimedProfileId: 'prof-1' }),
    });
    render(<ClaimProfile {...props} />);
    expect(await screen.findByTestId('claimed-badge')).toHaveTextContent('Verified owner');
  });

  it('claims the profile when the button is clicked and the API succeeds', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => userMe })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    render(<ClaimProfile {...props} />);
    await userEvent.click(await screen.findByTestId('claim-button'));

    expect(await screen.findByTestId('claimed-badge')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://api.example/profiles/prof-1/claim',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('hides the entry when claiming returns 403', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => userMe })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    const { container } = render(<ClaimProfile {...props} />);
    await userEvent.click(await screen.findByTestId('claim-button'));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
