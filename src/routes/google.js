const express = require('express');
const requireAppContext = require('../middleware/require-app-context');

function createGoogleRouter(db, { ConnectionsService, PROVIDERS }) {
  const router = express.Router();
  router.use(requireAppContext);   // PR 1.8

  // Helper to get a valid Google token
  async function getGoogleToken() {
    const connections = ConnectionsService.getConnectionsByProvider(db, 'google');
    if (!connections.length) {
      return { error: 'No Google connection found. Please connect Google in Settings.' };
    }

    const connection = connections[0]; // Use first Google connection

    // Check if token needs refresh
    let needsRefresh = false;
    if (connection.expires_at) {
      const expiresAt = new Date(connection.expires_at);
      const now = new Date();
      if (expiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
        needsRefresh = true;
      }
    }

    if (needsRefresh) {
      if (!connection.refresh_token) {
        return { error: 'Token expired and no refresh token available' };
      }

      const providerConfig = PROVIDERS.google;
      const credentials = ConnectionsService.getProviderCredentials(db, 'google');
      if (!credentials) {
        return { error: 'No Google credentials configured' };
      }

      try {
        const tokenResponse = await fetch(providerConfig.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: credentials.client_id,
            client_secret: credentials.client_secret,
            refresh_token: connection.refresh_token,
            grant_type: 'refresh_token'
          }).toString()
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error) {
          return { error: tokenData.error_description || tokenData.error };
        }

        let expiresAt = null;
        if (tokenData.expires_in) {
          expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
        }

        ConnectionsService.updateConnectionTokens(
          db,
          connection.id,
          tokenData.access_token,
          tokenData.refresh_token,
          expiresAt
        );

        return { token: tokenData.access_token };
      } catch (err) {
        return { error: `Token refresh failed: ${err.message}` };
      }
    }

    return { token: connection.access_token };
  }

  // ------------ Google Calendar ------------

  // List calendar events
  router.get('/calendar/events', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { maxResults = 10, timeMin, timeMax, q, calendarId = 'primary' } = req.query;

    try {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: timeMin || new Date().toISOString()
      });

      if (timeMax) params.append('timeMax', timeMax);
      if (q) params.append('q', q);

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        {
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        events: (data.items || []).map(event => ({
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
          location: event.location,
          status: event.status,
          htmlLink: event.htmlLink,
          attendees: event.attendees
        })),
        nextPageToken: data.nextPageToken
      });
    } catch (err) {
      console.error('Calendar events error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Create calendar event
  router.post('/calendar/events', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { summary, description, start, end, location, attendees, calendarId = 'primary' } = req.body;

    if (!summary || !start || !end) {
      return res.status(400).json({ error: 'summary, start, and end are required' });
    }

    try {
      // Build event object
      const event = {
        summary,
        description,
        location
      };

      // Handle date/time formats
      if (start.includes('T')) {
        event.start = { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        event.end = { dateTime: end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      } else {
        event.start = { date: start };
        event.end = { date: end };
      }

      if (attendees && Array.isArray(attendees)) {
        event.attendees = attendees.map(email => ({ email }));
      }

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(event)
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        event: {
          id: data.id,
          summary: data.summary,
          htmlLink: data.htmlLink
        }
      });
    } catch (err) {
      console.error('Calendar create error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update calendar event
  router.patch('/calendar/events/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { summary, description, start, end, location, attendees, calendarId = 'primary' } = req.body;

    try {
      const event = {};

      if (summary !== undefined) event.summary = summary;
      if (description !== undefined) event.description = description;
      if (location !== undefined) event.location = location;

      if (start && end) {
        if (start.includes('T')) {
          event.start = { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
          event.end = { dateTime: end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        } else {
          event.start = { date: start };
          event.end = { date: end };
        }
      }

      if (attendees && Array.isArray(attendees)) {
        event.attendees = attendees.map(email => ({ email }));
      }

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(event)
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        event: {
          id: data.id,
          summary: data.summary,
          htmlLink: data.htmlLink
        }
      });
    } catch (err) {
      console.error('Calendar update error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete calendar event
  router.delete('/calendar/events/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { calendarId = 'primary' } = req.query;

    try {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${id}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      if (response.status === 204) {
        return res.json({ success: true, deleted: true, eventId: id });
      }

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({ success: true, deleted: true, eventId: id });
    } catch (err) {
      console.error('Calendar delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ------------ Google Gmail ------------

  // List Gmail messages
  router.get('/gmail/messages', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { maxResults = 10, q, labelIds = 'INBOX', pageToken } = req.query;

    try {
      const params = new URLSearchParams({
        maxResults: String(maxResults)
      });

      if (q) params.append('q', q);
      if (labelIds) params.append('labelIds', labelIds);
      if (pageToken) params.append('pageToken', pageToken);

      // First get message list
      const listResponse = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages?${params}`,
        {
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      const listData = await listResponse.json();

      if (listData.error) {
        return res.status(listResponse.status).json({ error: listData.error.message });
      }

      // Fetch metadata for each message
      const messages = [];
      for (const msg of (listData.messages || []).slice(0, maxResults)) {
        const msgResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          {
            headers: { 'Authorization': `Bearer ${tokenResult.token}` }
          }
        );
        const msgData = await msgResponse.json();

        if (!msgData.error) {
          const headers = msgData.payload?.headers || [];
          const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

          messages.push({
            id: msgData.id,
            threadId: msgData.threadId,
            snippet: msgData.snippet,
            from: getHeader('From'),
            to: getHeader('To'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            labelIds: msgData.labelIds
          });
        }
      }

      res.json({
        messages,
        nextPageToken: listData.nextPageToken,
        resultSizeEstimate: listData.resultSizeEstimate
      });
    } catch (err) {
      console.error('Gmail list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get single Gmail message
  router.get('/gmail/messages/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { format = 'full' } = req.query;

    try {
      const response = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=${format}`,
        {
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      const headers = data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

      // Extract body
      let body = '';
      let bodyHtml = '';

      function extractBody(part) {
        if (part.body?.data) {
          const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
          if (part.mimeType === 'text/plain') {
            body = decoded;
          } else if (part.mimeType === 'text/html') {
            bodyHtml = decoded;
          }
        }
        if (part.parts) {
          for (const subPart of part.parts) {
            extractBody(subPart);
          }
        }
      }

      if (data.payload) {
        extractBody(data.payload);
      }

      // Extract attachments
      const attachments = [];
      function extractAttachments(part) {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size
          });
        }
        if (part.parts) {
          for (const subPart of part.parts) {
            extractAttachments(subPart);
          }
        }
      }

      if (data.payload) {
        extractAttachments(data.payload);
      }

      res.json({
        id: data.id,
        threadId: data.threadId,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        body: body || data.snippet,
        bodyHtml,
        attachments
      });
    } catch (err) {
      console.error('Gmail get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Send Gmail message
  router.post('/gmail/send', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { to, subject, body, bodyHtml, cc, bcc, replyTo } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }

    try {
      // Build RFC 2822 email
      const boundary = `----=_Part_${Date.now()}`;
      let email = '';

      email += `To: ${to}\r\n`;
      email += `Subject: ${subject}\r\n`;
      if (cc) email += `Cc: ${cc}\r\n`;
      if (bcc) email += `Bcc: ${bcc}\r\n`;
      email += `MIME-Version: 1.0\r\n`;

      if (bodyHtml) {
        email += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
        email += `--${boundary}\r\n`;
        email += `Content-Type: text/plain; charset=UTF-8\r\n\r\n`;
        email += `${body}\r\n\r\n`;
        email += `--${boundary}\r\n`;
        email += `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
        email += `${bodyHtml}\r\n\r\n`;
        email += `--${boundary}--`;
      } else {
        email += `Content-Type: text/plain; charset=UTF-8\r\n\r\n`;
        email += body;
      }

      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const requestBody = { raw: encodedEmail };
      if (replyTo) {
        requestBody.threadId = replyTo;
      }

      const response = await fetch(
        'https://www.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        messageId: data.id,
        threadId: data.threadId
      });
    } catch (err) {
      console.error('Gmail send error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete Gmail message (move to trash or permanent delete)
  router.delete('/gmail/messages/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { permanent } = req.query; // ?permanent=true for permanent delete

    try {
      let url, method;

      if (permanent === 'true') {
        // Permanent delete (requires full gmail access scope)
        url = `https://www.googleapis.com/gmail/v1/users/me/messages/${id}`;
        method = 'DELETE';
      } else {
        // Move to trash (safer, requires gmail.modify)
        url = `https://www.googleapis.com/gmail/v1/users/me/messages/${id}/trash`;
        method = 'POST';
      }

      const response = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${tokenResult.token}` }
      });

      if (method === 'DELETE' && response.status === 204) {
        // Successful permanent delete returns 204 No Content
        return res.json({ success: true, action: 'permanently_deleted', messageId: id });
      }

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        action: permanent === 'true' ? 'permanently_deleted' : 'trashed',
        messageId: data.id || id
      });
    } catch (err) {
      console.error('Gmail delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ------------ Google Drive ------------

  // List Drive files
  router.get('/drive/files', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { pageSize = 10, q, orderBy = 'modifiedTime desc', fields, pageToken } = req.query;

    try {
      const params = new URLSearchParams({
        pageSize: String(pageSize),
        orderBy,
        fields: fields || 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,iconLink,owners)'
      });

      if (q) params.append('q', q);
      if (pageToken) params.append('pageToken', pageToken);

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        {
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        files: data.files || [],
        nextPageToken: data.nextPageToken
      });
    } catch (err) {
      console.error('Drive list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get single Drive file metadata
  router.get('/drive/files/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;

    try {
      const fields = 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents,description,starred,trashed,owners,lastModifyingUser';

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?fields=${encodeURIComponent(fields)}`,
        {
          headers: { 'Authorization': `Bearer ${tokenResult.token}` }
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json(data);
    } catch (err) {
      console.error('Drive get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Create Drive folder
  router.post('/drive/folders', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { name, parentId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    try {
      const metadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder'
      };

      if (parentId) {
        metadata.parents = [parentId];
      }

      const response = await fetch(
        'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(metadata)
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        folder: data
      });
    } catch (err) {
      console.error('Drive create folder error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Upload Drive file (text/JSON content or base64)
  router.post('/drive/files', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { name, content, contentBase64, mimeType = 'text/plain', parentId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!content && !contentBase64) {
      return res.status(400).json({ error: 'content or contentBase64 is required' });
    }

    try {
      const metadata = { name };
      if (parentId) {
        metadata.parents = [parentId];
      }

      // Use multipart upload
      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const fileContent = contentBase64
        ? Buffer.from(contentBase64, 'base64')
        : Buffer.from(content, 'utf-8');

      const multipartBody = Buffer.concat([
        Buffer.from(
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          delimiter +
          `Content-Type: ${mimeType}\r\n` +
          'Content-Transfer-Encoding: base64\r\n\r\n'
        ),
        Buffer.from(fileContent.toString('base64')),
        Buffer.from(closeDelimiter)
      ]);

      const response = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        file: data
      });
    } catch (err) {
      console.error('Drive upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update Drive file metadata (rename, move, star, etc.)
  router.patch('/drive/files/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { name, description, starred, addParents, removeParents } = req.body;

    try {
      const metadata = {};
      if (name !== undefined) metadata.name = name;
      if (description !== undefined) metadata.description = description;
      if (starred !== undefined) metadata.starred = starred;

      const params = new URLSearchParams({
        fields: 'id,name,mimeType,size,webViewLink,parents,starred'
      });

      if (addParents) params.append('addParents', addParents);
      if (removeParents) params.append('removeParents', removeParents);

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?${params}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(metadata)
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.status(response.status).json({ error: data.error.message });
      }

      res.json({
        success: true,
        file: data
      });
    } catch (err) {
      console.error('Drive update error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete Drive file (trash or permanent)
  router.delete('/drive/files/:id', async (req, res) => {
    const tokenResult = await getGoogleToken();
    if (tokenResult.error) {
      return res.status(401).json({ error: tokenResult.error });
    }

    const { id } = req.params;
    const { permanent } = req.query;

    try {
      if (permanent === 'true') {
        // Permanent delete
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}`,
          {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${tokenResult.token}` }
          }
        );

        if (response.status === 204) {
          return res.json({ success: true, action: 'permanently_deleted', fileId: id });
        }

        const data = await response.json();
        if (data.error) {
          return res.status(response.status).json({ error: data.error.message });
        }

        res.json({ success: true, action: 'permanently_deleted', fileId: id });
      } else {
        // Move to trash
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${tokenResult.token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trashed: true })
          }
        );

        const data = await response.json();

        if (data.error) {
          return res.status(response.status).json({ error: data.error.message });
        }

        res.json({ success: true, action: 'trashed', fileId: id });
      }
    } catch (err) {
      console.error('Drive delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createGoogleRouter;

module.exports.meta = {
  name: 'google',
  description: 'Google Calendar, Gmail, and Drive APIs',
  basePath: '/api/google',
  connection: 'google',
  connectionScopes: 'calendar,gmail,drive',
  endpoints: [
    { method: 'GET', path: '/calendar/events', description: 'List calendar events',
      params: { timeMin: 'ISO date, optional', timeMax: 'ISO date, optional', maxResults: 'number, optional' } },
    { method: 'POST', path: '/calendar/events', description: 'Create calendar event',
      params: { summary: 'string, required', start: 'object, required', end: 'object, required', description: 'string, optional' } },
    { method: 'PATCH', path: '/calendar/events/:id', description: 'Update calendar event' },
    { method: 'DELETE', path: '/calendar/events/:id', description: 'Delete calendar event' },
    { method: 'GET', path: '/gmail/messages', description: 'List emails',
      params: { q: 'string — Gmail search query', maxResults: 'number, optional' } },
    { method: 'GET', path: '/gmail/messages/:id', description: 'Read a single email' },
    { method: 'POST', path: '/gmail/send', description: 'Send email',
      params: { to: 'string, required', subject: 'string, required', body: 'string, required' } },
    { method: 'DELETE', path: '/gmail/messages/:id', description: 'Delete email' },
    { method: 'GET', path: '/drive/files', description: 'List Drive files' },
    { method: 'POST', path: '/drive/files', description: 'Upload file to Drive' },
    { method: 'GET', path: '/drive/files/:id', description: 'Download file from Drive' },
    { method: 'DELETE', path: '/drive/files/:id', description: 'Delete file from Drive' }
  ]
};
