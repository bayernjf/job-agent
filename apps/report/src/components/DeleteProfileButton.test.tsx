// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeleteProfileButton from './DeleteProfileButton';

const props = {
  apiBase: 'https://api.example',
  profileId: 'prof-1',
  cardId: 'card-1',
  deleteLabel: 'Delete',
  confirmTitle: 'Confirm delete?',
  confirmBody: 'This cannot be undone.',
  cancelLabel: 'Cancel',
  okLabel: 'Deleting…',
  errorLabel: 'Delete failed',
  hintLabel: 'Delete this profile',
};

describe('DeleteProfileButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  it('opens the confirm state and cancels without calling the API', async () => {
    render(<DeleteProfileButton {...props} />);
    await userEvent.click(screen.getByTestId('delete-profile-button'));

    // confirm state shows cancel + confirm buttons
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not delete when the native confirm dialog is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DeleteProfileButton {...props} />);
    await userEvent.click(screen.getByTestId('delete-profile-button'));
    await userEvent.click(screen.getByTestId('delete-profile-confirm'));

    expect(window.confirm).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('deletes and removes the card when confirmed and the API succeeds', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.fn();
    vi.spyOn(document, 'getElementById').mockReturnValue({ remove } as unknown as HTMLElement);
    // keep the list non-empty so the page does not reload
    vi.spyOn(document, 'querySelector').mockReturnValue({
      children: { length: 1 },
    } as unknown as Element);
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<DeleteProfileButton {...props} />);
    await userEvent.click(screen.getByTestId('delete-profile-button'));
    await userEvent.click(screen.getByTestId('delete-profile-confirm'));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith('https://api.example/profiles/prof-1', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('shows an error when the API responds not-ok', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    render(<DeleteProfileButton {...props} />);
    await userEvent.click(screen.getByTestId('delete-profile-button'));
    await userEvent.click(screen.getByTestId('delete-profile-confirm'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
  });
});
