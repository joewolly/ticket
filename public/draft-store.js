let connection;
function open() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('taskhub-drafts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('drafts', { keyPath: 'id' });
      request.onerror = () => {
        connection = null;
        reject(request.error);
      };
      request.onsuccess = () => resolve(request.result);
    });
  return connection;
}
async function run(mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode),
      request = operation(tx.objectStore('drafts'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(
        tx.error ||
          request.error ||
          new Error('Could not save this draft on the device'),
      );
  });
}
export const listDrafts = () => run('readonly', (s) => s.getAll());
export const getDraft = (id) => run('readonly', (s) => s.get(id));
export const putDraft = (draft) => run('readwrite', (s) => s.put(draft));
export const deleteDraft = (id) => run('readwrite', (s) => s.delete(id));
export const clearDrafts = () => run('readwrite', (s) => s.clear());
