import fs from 'node:fs';

/**
 * Uploads a locally-generated .docx and asks Drive to convert it into a
 * native Google Doc (mimeType: application/vnd.google-apps.document), so
 * the client gets a real, editable/commentable Google Doc rather than a
 * Word file sitting in Drive.
 *
 * Requires a Google Cloud service account with the Drive API enabled, whose
 * key JSON is passed via --gdoc-credentials. The target Drive folder
 * (--gdoc-folder) must be shared with that service account's email
 * (Editor access) — service accounts have no personal Drive storage of
 * their own, so uploads always need a shared destination folder.
 */
export async function uploadDocxAsGoogleDoc({ docxPath, credentialsPath, folderId, name }) {
  const { google } = await import('googleapis');

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: fs.createReadStream(docxPath),
    },
    fields: 'id, webViewLink',
  });

  return res.data.webViewLink || `https://docs.google.com/document/d/${res.data.id}/edit`;
}
