// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClaimVerifier from './ClaimVerifier';

const labels = {
  title: 'Resume claim verification',
  hint: 'Check each claim',
  inputLabel: 'Resume claim',
  inputPlaceholder: 'e.g. Built services in TypeScript',
  submit: 'Verify claim',
  submitting: 'Verifying…',
  loading: 'Loading verifications…',
  error: 'The action failed',
  empty: 'No verifications yet',
  evidenceTitle: 'Supporting evidence',
  withdraw: 'Withdraw',
  withdrawing: 'Withdrawing…',
  verdict: {
    supportable: 'Supported by evidence',
    partial: 'Partially supported',
    no_trace: 'No trace observed',
    insufficient_data: 'Not verifiable yet',
  },
};

const props = { apiBase: 'https://api.example', profileId: 'prof-1', labels };

function existingClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claimv-1',
    claimText: 'Built services in TypeScript',
    verdict: 'supportable',
    matchedEvidenceRefs: ['e1'],
    matchedEvidence: [
      { id: 'e1', url: 'https://github.com/alice/api/commit/a1', claim: 'TypeScript refactor' },
    ],
    confidence: 0.8,
    ruleVersion: '0.1',
    requiredEvidenceCount: 2,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('ClaimVerifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists existing verdicts and links the supporting evidence', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [existingClaim()] }),
    });
    render(<ClaimVerifier {...props} />);

    expect(await screen.findByTestId('claim-verifier')).toHaveAttribute(
      'data-hydrated',
      'true',
    );
    expect(await screen.findByText('Built services in TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Supported by evidence')).toBeInTheDocument();
    const link = screen.getByText('TypeScript refactor ↗');
    expect(link.closest('a')).toHaveAttribute(
      'href',
      'https://github.com/alice/api/commit/a1',
    );
  });

  it('shows the empty state when there are no verifications', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    });
    render(<ClaimVerifier {...props} />);
    expect(await screen.findByText('No verifications yet')).toBeInTheDocument();
  });

  it('creates a claim and prepends the returned verdict', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => existingClaim(),
      });

    render(<ClaimVerifier {...props} />);
    await screen.findByText('No verifications yet');

    await userEvent.type(screen.getByTestId('claim-input'), 'Built services in TypeScript');
    await userEvent.click(screen.getByRole('button', { name: 'Verify claim' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith(
        'https://api.example/profiles/prof-1/claim-verifications',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('Built services in TypeScript')).toBeInTheDocument();
  });

  it('withdraws a claim when the withdraw button is clicked', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [existingClaim()] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ deleted: true }) });

    render(<ClaimVerifier {...props} />);
    await screen.findByText('Built services in TypeScript');
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith(
        'https://api.example/claim-verifications/claimv-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('Built services in TypeScript')).not.toBeInTheDocument(),
    );
  });

  it('hides entirely when the list returns 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { container } = render(<ClaimVerifier {...props} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides entirely when the list returns 403', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const { container } = render(<ClaimVerifier {...props} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('does not call a fabricated verdict "no trace": insufficient_data uses its own label', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          existingClaim({
            id: 'claimv-2',
            claimText: 'A great team player',
            verdict: 'insufficient_data',
            matchedEvidenceRefs: [],
            matchedEvidence: [],
            confidence: null,
          }),
        ],
      }),
    });
    render(<ClaimVerifier {...props} />);
    expect(await screen.findByText('Not verifiable yet')).toBeInTheDocument();
    expect(screen.queryByText('No trace observed')).not.toBeInTheDocument();
  });
});
