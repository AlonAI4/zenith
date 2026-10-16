import { closeOnEscape } from './escapeKey.js';

/**
 * The My photos panel: every photo taken of a camera's picture, newest
 * first. Click one to see it large; Delete asks first. The photos live in
 * Zenith's own files on this computer (server/alon/cctvPhotos.js).
 */

export const PHOTOS_ROUTE = '/api/alon/cctv/photos';

/** "16 Oct, 14:40", in the viewer's own time unless a zone is given. */
export function photoWhen(time, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(time);
}

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const STYLE = `
#my-photos {
  position: fixed; top: var(--zenith-panel-top, 92px); left: 50%; z-index: 182;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - var(--zenith-panel-top, 92px) - 38px); overflow-y: auto;
  transform: translateX(-50%); padding: 14px 16px 12px;
  border: 1px solid rgba(0, 246, 255, 0.35); border-radius: 12px;
  background: rgba(4, 12, 20, 0.96); box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: rgba(222, 246, 255, 0.92); font: 12px/1.4 var(--font-mono, ui-monospace, monospace);
  color-scheme: dark; scrollbar-width: thin;
}
#my-photos[hidden], #my-photos [hidden], body.ui-clean-view #my-photos { display: none; }
#my-photos .mp-head { position: sticky; top: -14px; display: flex; align-items: center; justify-content: space-between;
  margin: -14px -16px 10px; padding: 14px 16px 8px; background: rgba(4, 12, 20, 0.98); }
#my-photos h2 { margin: 0; font-size: 12px; letter-spacing: 0.22em; color: #00f6ff; }
#my-photos button { border: 1px solid rgba(0, 246, 255, 0.35); background: transparent; color: inherit; font: inherit;
  border-radius: 6px; padding: 4px 8px; cursor: pointer; }
#my-photos button:focus-visible { outline: 2px solid #00f6ff; outline-offset: 1px; }
#my-photos .mp-close { display: inline-flex; padding: 4px; }
#my-photos .mp-note { margin: 0 0 10px; color: #9fc3d3; }
#my-photos ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
#my-photos li button { display: grid; grid-template-columns: 96px 1fr; gap: 10px; width: 100%; text-align: left; padding: 6px; }
#my-photos li img { width: 96px; height: 54px; object-fit: cover; border-radius: 4px; background: #000; }
#my-photos .mp-name { display: block; color: #e6faff; }
#my-photos .mp-time { display: block; color: #9fc3d3; }
#my-photos .mp-big img { width: 100%; height: auto; border-radius: 6px; background: #000; display: block; }
#my-photos .mp-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
#my-photos .mp-danger { border-color: rgba(255, 120, 120, 0.6); color: #ffb3b3; }
#my-photos .mp-said { margin: 8px 0 0; min-height: 1.3em; color: #ffd27a; }
`;

/**
 * @param {Document} doc
 * @param {{ fetchJson: (url: string, init?: object) => Promise<any>, onChange?: () => void }} options
 */
export function createMyPhotos(doc, { fetchJson, onChange = () => {} }) {
  const win = doc.defaultView ?? window;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const panel = doc.createElement('section');
  panel.id = 'my-photos';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'My photos');

  const head = doc.createElement('div');
  head.className = 'mp-head';
  const title = doc.createElement('h2');
  title.textContent = 'MY PHOTOS';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'mp-close';
  close.innerHTML = CLOSE_ICON;
  close.setAttribute('aria-label', 'Close my photos');
  head.append(title, close);

  const note = doc.createElement('p');
  note.className = 'mp-note';
  note.textContent =
    'Photos are kept only on this computer, in Zenith’s own files. They are never uploaded.';

  const list = doc.createElement('ul');
  const empty = doc.createElement('p');
  empty.className = 'mp-note';
  empty.textContent = 'No photos yet. Pick a camera and press Take photo.';

  const big = doc.createElement('div');
  big.className = 'mp-big';
  big.hidden = true;
  const bigPicture = doc.createElement('img');
  const caption = doc.createElement('p');
  const actions = doc.createElement('div');
  actions.className = 'mp-row';
  const back = doc.createElement('button');
  back.type = 'button';
  back.textContent = 'Back to the list';
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'mp-danger';
  remove.textContent = 'Delete';
  actions.append(back, remove);
  const confirm = doc.createElement('div');
  confirm.className = 'mp-row';
  confirm.hidden = true;
  const ask = doc.createElement('span');
  ask.textContent = 'Delete this photo? It cannot be undone.';
  const yes = doc.createElement('button');
  yes.type = 'button';
  yes.className = 'mp-danger';
  yes.textContent = 'Yes, delete';
  const no = doc.createElement('button');
  no.type = 'button';
  no.textContent = 'Keep it';
  confirm.append(ask, yes, no);
  big.append(bigPicture, caption, actions, confirm);

  const said = doc.createElement('p');
  said.className = 'mp-said';
  said.setAttribute('role', 'status');

  panel.append(head, note, list, empty, big, said);
  doc.body.appendChild(panel);

  let photos = [];
  let showing = null;
  let opener = null;

  const showList = () => {
    showing = null;
    big.hidden = true;
    confirm.hidden = true;
    list.hidden = photos.length === 0;
    empty.hidden = photos.length > 0;
  };

  const showPhoto = (photo, from) => {
    showing = photo;
    list.hidden = true;
    empty.hidden = true;
    big.hidden = false;
    confirm.hidden = true;
    actions.hidden = false;
    bigPicture.src = `${PHOTOS_ROUTE}/${encodeURIComponent(photo.file)}`;
    bigPicture.alt = `${photo.name}, ${photoWhen(photo.time)}`;
    caption.textContent = `${photo.name}${photo.place ? ` · ${photo.place}` : ''} · ${photoWhen(photo.time)}. Picture: ${photo.network}.`;
    back.dataset.returnTo = from?.dataset.file ?? '';
    back.focus();
  };

  const render = () => {
    list.replaceChildren(
      ...photos.map((photo) => {
        const item = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset.file = photo.file;
        const thumb = doc.createElement('img');
        thumb.src = `${PHOTOS_ROUTE}/${encodeURIComponent(photo.file)}`;
        thumb.alt = '';
        thumb.loading = 'lazy';
        const words = doc.createElement('span');
        const name = doc.createElement('span');
        name.className = 'mp-name';
        name.textContent = photo.name || photo.cameraId;
        const when = doc.createElement('span');
        when.className = 'mp-time';
        when.textContent = `${photo.place ? `${photo.place} · ` : ''}${photoWhen(photo.time)}`;
        words.append(name, when);
        button.append(thumb, words);
        button.addEventListener('click', () => showPhoto(photo, button));
        item.appendChild(button);
        return item;
      }),
    );
    showList();
  };

  async function refresh() {
    try {
      const answer = await fetchJson(PHOTOS_ROUTE);
      photos = Array.isArray(answer?.photos) ? answer.photos : [];
      said.textContent = answer?.full
        ? 'The photos folder is full. Delete some photos to take more.'
        : '';
    } catch {
      photos = [];
      said.textContent = 'Could not read the photos.';
    }
    render();
    return photos;
  }

  const open = async (from) => {
    opener = from ?? null;
    panel.hidden = false;
    await refresh();
    close.focus();
  };

  const hide = () => {
    panel.hidden = true;
    showList();
  };

  close.addEventListener('click', () => {
    hide();
    opener?.focus();
  });
  back.addEventListener('click', () => {
    const file = back.dataset.returnTo;
    showList();
    (list.querySelector(`[data-file="${file}"]`) ?? close).focus?.();
  });
  remove.addEventListener('click', () => {
    actions.hidden = true;
    confirm.hidden = false;
    no.focus();
  });
  no.addEventListener('click', () => {
    confirm.hidden = true;
    actions.hidden = false;
    remove.focus();
  });
  yes.addEventListener('click', async () => {
    if (!showing) return;
    let words;
    try {
      await fetchJson(`${PHOTOS_ROUTE}/${encodeURIComponent(showing.file)}`, {
        method: 'DELETE',
      });
      words = 'Photo deleted.';
    } catch {
      words = 'Could not delete the photo.';
    }
    await refresh();
    said.textContent = words;
    onChange();
    close.focus();
  });

  // Escape: from a large photo back to the list, then closes the panel.
  const offEscape = closeOnEscape(
    win,
    () => !panel.hidden,
    () => {
      if (showing) showList();
      else hide();
    },
    {
      panel,
      opener: { focus: () => (panel.hidden ? opener?.focus() : close.focus()) },
    },
  );

  return {
    open,
    refresh,
    isOpen: () => !panel.hidden,
    remove: () => {
      offEscape();
      panel.remove();
      style.remove();
    },
  };
}
