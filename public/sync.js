// Offline-first sync system
class OfflineSync {
  constructor() {
    this.db = null;
    this.dbName = 'DataEntryApp';
    this.storeName = 'pendingOperations';
    this.isOnline = navigator.onLine;
    this.init();
  }

  async init() {
    this.db = await this.openDB();
    
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());

    // Listen if BACK_ONLINE
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'BACK_ONLINE') {
          console.log('SW confirms we are back online');
          this.handleOnline();
        }
      });
      navigator.serviceWorker.ready.then(registration => {
        console.log('SW ready');
      });
    }

    // Show initial offline status
    const statusDiv = document.getElementById('offline-status');
    if (!this.isOnline && statusDiv) {
      statusDiv.style.display = 'block';
    }

    // makes pending creates/deletes visible even when navigating between pages
    await this.renderPendingFromIndexedDB();

    // sync when online
    if (this.isOnline) {
      const synced = await this.syncPending();
      // If synced something, refresh page so to show fresh data
      if (synced && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'REFRESH_PAGE_CACHE' });
      }
    }

    console.log('OfflineSync initialized. Online:', this.isOnline);
  }

  // Read all pending operations from IndexedDB that belong to the selected event
  async renderPendingFromIndexedDB() {
    if (!this.db) return;
    const operations = await this.getPendingOperations();
    if (operations.length === 0) return;

    const currentEventId = this.getCurrentEventId();
    if (!currentEventId) return;

    const isFormPage = document.querySelector('.form-card') !== null;
    const isDetailPage = document.querySelector('.form-cards') !== null;

    for (const op of operations) {
      // Only render operations that belong to the current event page
      const opEventId = op.data ? parseInt(op.data.event_id) : null;
      if (opEventId !== currentEventId) {
        continue;
      }

      if (op.operation === 'CREATE') {
        if (isFormPage) {
          // On form pages — only render if the table matches the current form type
          // The current form page's table is known from data-offline-sync on the form
          const currentFormTable = document.querySelector('form[data-offline-sync]')?.dataset?.offlineSync;
          if (currentFormTable && op.table !== currentFormTable) {
            continue;
          }
          const operatorName = op.data ? this.getOperatorNameFromForm(op.data.operator_id) : 'Unknown';
          this.addPendingRecordToTable(op.table, op.data, operatorName);
        } 
        else if (isDetailPage) {
          const operatorName = op.data ? this.getOperatorNameFromForm(op.data.operator_id) : 'Unknown';
          this.addPendingRecordToEventDetail(op.table, op.data, operatorName);
        }
      } 
      else if (op.operation === 'DELETE') {
        // Mark the deleted row visually on any page
        this.markPendingDeleteOnCurrentPage(op.table, op.recordId);
      }
    }
  }

  // Extract current event ID from the page URL (e.g. /events/1 or /events/1/forms/baseline)
  getCurrentEventId() {
    const match = window.location.pathname.match(/\/events\/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  // Get operator name from a select dropdown on the current page
  getOperatorNameFromForm(operatorId) {
    const select = document.querySelector('select[name="operator_id"]');
    if (select) {
      for (const opt of select.options) {
        if (opt.value === String(operatorId)) return opt.text;
      }
    }
    return 'Unknown';
  }

  // Visually mark a pending delete operation on the current page
  markPendingDeleteOnCurrentPage(table, recordId) {
    const deleteBtns = document.querySelectorAll(`form[action*="/${table}/${recordId}"]`);
    deleteBtns.forEach(form => {
      const row = form.closest('tr');
      if (row) {
        row.style.opacity = '0.4';
        row.style.textDecoration = 'line-through';
        row.style.backgroundColor = '#fff3cd';
      }
    });
  }

  // Create or open IndexedDB database
  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 2);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
          store.createIndex('operation', 'operation', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
        }
        
        if (event.oldVersion < 2) {
          const store = event.target.transaction.objectStore(this.storeName);
          if (!store.indexNames.contains('operation')) {
            store.createIndex('operation', 'operation', { unique: false });
          }
          if (!store.indexNames.contains('synced')) {
            store.createIndex('synced', 'synced', { unique: false });
          }
        }
      };
    });
  }

  // Save an operation to IndexedDB (offline)
  async saveOperation(operation, table, data, recordId = null) {
    if (!this.db) return false;

    return new Promise((resolve) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      const opRecord = {
        operation,
        table,
        data,
        recordId,
        timestamp: new Date().toISOString(),
        synced: false
      };

      const request = store.add(opRecord);
      request.onsuccess = () => {
        console.log('Saved operation to IndexedDB:', operation, table);
        resolve(true);
      };
      request.onerror = () => resolve(false);
    });
  }

  async saveRecord(table, data) {
    return this.saveOperation('CREATE', table, data);
  }

  async getPendingOperations() {
    if (!this.db) return [];

    return new Promise((resolve) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const operations = request.result.filter(op => !op.synced);
        operations.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        resolve(operations);
      };
      request.onerror = () => resolve([]);
    });
  }

  async getPendingRecords() {
    return this.getPendingOperations();
  }

  async markAsSynced(ids) {
    if (!this.db) return;

    return new Promise((resolve) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      ids.forEach(id => {
        const request = store.get(id);
        request.onsuccess = () => {
          const record = request.result;
          record.synced = true;
          store.put(record);
        };
      });

      resolve();
    });
  }

  async syncPending() {
    const pending = await this.getPendingOperations();
    if (pending.length === 0) {
      console.log('No pending operations to sync');
      return 'NO_DATA'; 
    }

    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: pending })
      });

      if (response.ok) {
        const result = await response.json();
        const syncedIds = pending.map(op => op.id);
        await this.markAsSynced(syncedIds);
        console.log(`Synced ${result.synced} operations to server`);
        return 'SYNCED';
      } else {
        console.error('Sync failed:', response.status);
        return 'FAILED';
      }
    } catch (err) {
      console.error('Sync error:', err);
      return 'FAILED';
    }
  }

  async handleOnline() {
    console.log('Connection restored');
    this.isOnline = true;
    
    const statusDiv = document.getElementById('offline-status');
    if (statusDiv) statusDiv.style.display = 'none';

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'REFRESH_PAGE_CACHE' });
    }

    // Capture the specific text status
    const syncResult = await this.syncPending();
    
    switch (syncResult) {
      case 'SYNCED':
        this.showNotification('Data synced successfully. Refreshing page...', 'success');
        setTimeout(() => {
          window.location.reload();
        }, 1500);
        break;
        
      case 'NO_DATA':
        this.showNotification('Connection restored. You are back online.', 'success');
        break;
        
      case 'FAILED':
        this.showNotification(
        'Sync failed. Connection might be unstable.', 'error'
      );
        break;
    }
  }

  handleOffline() {
    console.log('Connection lost');
    this.isOnline = false;
    const statusDiv = document.getElementById('offline-status');
    if (statusDiv) statusDiv.style.display = 'block';
    this.showNotification('Connection lost. Saving data locally', 'warning');
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 4px;
      z-index: 9999;
      font-size: 14px;
      animation: slideIn 0.3s ease;
    `;

    switch (type) {
      case 'success':
        notification.style.backgroundColor = '#4caf50';
        notification.style.color = 'white';
        break;
      case 'error':
        notification.style.backgroundColor = '#f44336';
        notification.style.color = 'white';
        break;
      case 'warning':
        notification.style.backgroundColor = '#ff9800';
        notification.style.color = 'white';
        break;
      case 'info':
      default:
        notification.style.backgroundColor = '#2196f3';
        notification.style.color = 'white';
    }

    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
  }

  interceptForms() {
    document.querySelectorAll('form[data-offline-sync]').forEach(form => {
      form.addEventListener('submit', async (e) => {
        if (!this.isOnline) {
          e.preventDefault();
          
          const formData = new FormData(form);
          const data = Object.fromEntries(formData);
          const table = form.dataset.offlineSync;
          
          const actionMatch = form.action.match(/\/events\/(\d+)\/forms/);
          if (actionMatch) {
            data.event_id = actionMatch[1];
          }

          const operatorSelect = form.querySelector('select[name="operator_id"]');
          const operatorName = operatorSelect ? operatorSelect.options[operatorSelect.selectedIndex]?.text : 'Unknown';

          console.log('Saving offline record:', { table, data });

          const saved = await this.saveRecord(table, data);
          
          if (saved) {
            this.showNotification('Saved locally. Will sync when online', 'warning');
            form.reset();
            this.addPendingRecordToUI(table, data, operatorName);
          } else {
            this.showNotification('Failed to save locally. Please try again', 'error');
          }
        }
      });
    });
  }

  addPendingRecordToUI(table, data, operatorName) {
    const tableElement = document.querySelector('.table');
    
    if (tableElement) {
      this.addPendingRecordToTable(table, data, operatorName);
    } else {
      this.addPendingRecordToEventDetail(table, data, operatorName);
    }
  }

  addPendingRecordToTable(table, data, operatorName) {
    const tableElement = document.querySelector('.table');
    if (!tableElement) return;
    
    const tbody = tableElement.querySelector('tbody');
    if (!tbody) return;
    
    let rowHtml = '';
    
    if (table === 'baseline_records') {
      const bmi = data.height && data.weight ? (data.weight / ((data.height/100)*(data.height/100))).toFixed(1) : '-';
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.height}</td>
          <td>${data.weight}</td>
          <td>${bmi}</td>
          <td>${data.waist_circumference}</td>
          <td>${data.hip_circumference}</td>
          <td>${data.grip_strength}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;"></span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'pyrocks_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td><span class="badge badge-risk-${data.risk?.toLowerCase() || 'low'}">${data.risk}</span></td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;"></span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'donutech_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.blood_pressure}</td>
          <td>${data.heart_rate}</td>
          <td>${data.blood_glucose}</td>
          <td>${data.time_since_last_meal}</td>
          <td>${data.remarks || ''}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;"></span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'sg_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.serial_number}</td>
          <td>${data.subject_id}</td>
          <td>${data.hba1c}</td>
          <td>${data.total_cholesterol}</td>
          <td>${data.hdl}</td>
          <td>${data.trig}</td>
          <td>${data.ldl}</td>
          <td>${data.glucose_donutech}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;"></span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    }
    
    tbody.insertAdjacentHTML('afterbegin', rowHtml);
    
    // Show the table-scroll div if it was hidden (initial 0 records case)
    const tableScroll = document.querySelector('.table-scroll');
    if (tableScroll) {
      tableScroll.style.display = '';
    }
    
    // Remove the "No records yet" message if present (it's outside the table, sibling of table-scroll)
    const noRecordsMessage = document.querySelector('.card.records-card .text-muted');
    if (noRecordsMessage && noRecordsMessage.textContent === 'No records yet.') {
      noRecordsMessage.remove();
    }
    
    const countElement = document.querySelector('.card.records-card h2');
    if (countElement) {
      const currentText = countElement.textContent;
      const match = currentText.match(/Records \((\d+)\)/);
      if (match) {
        const newCount = parseInt(match[1]) + 1;
        countElement.textContent = `Records (${newCount})`;
      }
    }
    
    const formType = table.replace('_records', '');
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => {
      const header = card.querySelector('.card-header h2');
      if (header && header.textContent.toLowerCase().includes(formType)) {
        const badge = card.querySelector('.badge');
        if (badge) {
          const currentCount = parseInt(badge.textContent) || 0;
          badge.textContent = currentCount + 1;
        }
      }
    });
  }

  addPendingRecordToEventDetail(table, data, operatorName) {
    const formType = table.replace('_records', '');
    const formTypeCapitalized = formType.charAt(0).toUpperCase() + formType.slice(1);
    
    // Update the form-cards badge at the top of the event detail page
    this.updateDetailBadge(formType, 1);
    
    const detailsElements = document.querySelectorAll('details');
    let targetDetails = null;
    
    detailsElements.forEach(details => {
      const summary = details.querySelector('summary');
      if (summary && summary.textContent.toLowerCase().includes(formType)) {
        targetDetails = details;
      }
    });
    
    if (!targetDetails) {
      this.createDetailsSectionForPendingRecord(table, data, operatorName);
      return;
    }
    
    const tbody = targetDetails.querySelector('tbody');
    if (!tbody) return;
    
    let rowHtml = '';
    
    if (table === 'baseline_records') {
      const bmi = data.height && data.weight ? (data.weight / ((data.height/100)*(data.height/100))).toFixed(1) : '-';
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.height}</td>
          <td>${data.weight}</td>
          <td>${bmi}</td>
          <td>${data.waist_circumference}</td>
          <td>${data.hip_circumference}</td>
          <td>${data.grip_strength}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'pyrocks_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.risk}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'donutech_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.blood_pressure}</td>
          <td>${data.heart_rate}</td>
          <td>${data.blood_glucose}</td>
          <td>${data.time_since_last_meal}</td>
          <td>${data.remarks || ''}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    } else if (table === 'sg_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.serial_number}</td>
          <td>${data.subject_id}</td>
          <td>${data.hba1c}</td>
          <td>${data.total_cholesterol}</td>
          <td>${data.hdl}</td>
          <td>${data.trig}</td>
          <td>${data.ldl}</td>
          <td>${data.glucose_donutech}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
    }
    
    tbody.insertAdjacentHTML('afterbegin', rowHtml);
    targetDetails.open = true;
    
    const summary = targetDetails.querySelector('summary');
    if (summary) {
      const match = summary.textContent.match(/\((\d+)\)/);
      if (match) {
        const newCount = parseInt(match[1]) + 1;
        summary.textContent = `${formTypeCapitalized} (${newCount})`;
      }
    }
  }

  // Update the form-cards badge count on the event detail page
  updateDetailBadge(formType, delta) {
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => {
      const header = card.querySelector('.card-header h2');
      if (header && header.textContent.toLowerCase().includes(formType)) {
        const badge = card.querySelector('.badge');
        if (badge) {
          const match = badge.textContent.match(/(\d+)/);
          if (match) {
            const newCount = Math.max(0, parseInt(match[1]) + delta);
            badge.textContent = `${newCount} records`;
          }
        }
      }
    });
  }

  createDetailsSectionForPendingRecord(table, data, operatorName) {
    const formType = table.replace('_records', '');
    const formTypeCapitalized = formType.charAt(0).toUpperCase() + formType.slice(1);
    
    const recentRecordsHeading = document.querySelector('h2');
    if (!recentRecordsHeading) return;
    
    let tableHtml = '';
    let rowHtml = '';
    
    if (table === 'baseline_records') {
      const bmi = data.height && data.weight ? (data.weight / ((data.height/100)*(data.height/100))).toFixed(1) : '-';
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.height}</td>
          <td>${data.weight}</td>
          <td>${bmi}</td>
          <td>${data.waist_circumference}</td>
          <td>${data.hip_circumference}</td>
          <td>${data.grip_strength}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
      tableHtml = `
        <table class="table">
          <thead><tr><th>Subject ID</th><th>Height</th><th>Weight</th><th>BMI</th><th>Waist</th><th>Hip</th><th>Grip</th><th>Operator</th><th></th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>
      `;
    } else if (table === 'pyrocks_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.risk}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
      tableHtml = `
        <table class="table">
          <thead><tr><th>Subject ID</th><th>Risk</th><th>Operator</th><th></th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>
      `;
    } else if (table === 'donutech_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.subject_id}</td>
          <td>${data.blood_pressure}</td>
          <td>${data.heart_rate}</td>
          <td>${data.blood_glucose}</td>
          <td>${data.time_since_last_meal}</td>
          <td>${data.remarks || ''}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
      tableHtml = `
        <table class="table">
          <thead><tr><th>Subject ID</th><th>BP</th><th>HR</th><th>Glucose</th><th>Last Meal</th><th>Remarks</th><th>Operator</th><th></th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>
      `;
    } else if (table === 'sg_records') {
      rowHtml = `
        <tr class="pending-record" style="opacity: 0.7; background-color: #fff3cd;">
          <td>${data.serial_number}</td>
          <td>${data.subject_id}</td>
          <td>${data.hba1c}</td>
          <td>${data.total_cholesterol}</td>
          <td>${data.hdl}</td>
          <td>${data.trig}</td>
          <td>${data.ldl}</td>
          <td>${data.glucose_donutech}</td>
          <td>${operatorName} <span style="font-size: 11px; color: #856404;">(pending)</span></td>
          <td><span style="color: #856404;">Syncing...</span></td>
        </tr>
      `;
      tableHtml = `
        <table class="table">
          <thead><tr><th>S/N</th><th>Subject ID</th><th>HbA1C</th><th>Chol</th><th>HDL</th><th>TRIG</th><th>LDL</th><th>Gluc(DT)</th><th>Operator</th><th></th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>
      `;
    }
    
    const detailsHtml = `
      <details open>
        <summary>${formTypeCapitalized} (1)</summary>
        ${tableHtml}
      </details>
    `;
    
    recentRecordsHeading.insertAdjacentHTML('afterend', detailsHtml);
  }

  interceptDeleteForms() {
    document.querySelectorAll('form[data-delete-sync]').forEach(form => {
      form.addEventListener('submit', async (e) => {
        if (!this.isOnline) {
          e.preventDefault();
          
          const actionMatch = form.action.match(/\/events\/(\d+)\/records\/([^/]+)\/(\d+)/);
          if (actionMatch) {
            const [, eventId, table, recordId] = actionMatch;
            
            console.log('Queueing delete operation:', { table, recordId });

            const saved = await this.saveOperation('DELETE', table, { event_id: eventId }, recordId);
            
            if (saved) {
              this.showNotification('✓ Delete queued. Will sync when online', 'warning');
              
              const row = form.closest('tr');
              if (row) {
                row.style.opacity = '0.5';
                row.style.textDecoration = 'line-through';
              }
              
              const countElement = document.querySelector('.card.records-card h2');
              if (countElement) {
                const currentText = countElement.textContent;
                const match = currentText.match(/Records \((\d+)\)/);
                if (match) {
                  const newCount = Math.max(0, parseInt(match[1]) - 1);
                  countElement.textContent = `Records (${newCount})`;
                }
              }
              
              const formType = table.replace('_records', '');
              const cards = document.querySelectorAll('.card');
              cards.forEach(card => {
                const header = card.querySelector('.card-header h2');
                if (header && header.textContent.toLowerCase().includes(formType)) {
                  const badge = card.querySelector('.badge');
                  if (badge) {
                    const currentCount = parseInt(badge.textContent) || 0;
                    badge.textContent = Math.max(0, currentCount - 1);
                  }
                }
              });
              
              const detailsElements = document.querySelectorAll('details');
              detailsElements.forEach(details => {
                const summary = details.querySelector('summary');
                if (summary && summary.textContent.toLowerCase().includes(formType)) {
                  const match = summary.textContent.match(/\((\d+)\)/);
                  if (match) {
                    const newCount = Math.max(0, parseInt(match[1]) - 1);
                    const formTypeCapitalized = formType.charAt(0).toUpperCase() + formType.slice(1);
                    summary.textContent = `${formTypeCapitalized} (${newCount})`;
                  }
                }
              });
            } else {
              this.showNotification('✗ Failed to queue delete. Please try again', 'error');
            }
          }
        }
      });
    });
  }

}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  window.offlineSync = new OfflineSync();
  window.offlineSync.interceptForms();
  window.offlineSync.interceptDeleteForms();

  // Register Service Worker for offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('Service Worker registered:', registration);
      })
      .catch((error) => {
        console.log('Service Worker registration failed:', error);
      });
  }
});
