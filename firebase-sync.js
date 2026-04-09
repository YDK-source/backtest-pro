/* ================================================================
   BACKTEST PRO — firebase-sync.js
   Loaded AFTER app.js so it can reference state / navigate / toast.
   ================================================================ */

(function () {
  window.firebaseReady = false;
  window.currentRoomId = null;

  // Check that the user has filled in firebase-config.js
  const configured =
    typeof FIREBASE_CONFIG !== 'undefined' &&
    !Object.values(FIREBASE_CONFIG).some(v => String(v).startsWith('REPLACE_ME'));

  if (!configured) {
    console.warn('Backtest Pro: Firebase config not filled in — running in local mode.');
    return;
  }

  try {
    firebase.initializeApp(FIREBASE_CONFIG);
  } catch (e) {
    console.error('Firebase init failed:', e);
    return;
  }

  const db = firebase.firestore();
  window.firebaseReady = true;

  let unsubscribe = null;

  // ── Join a room and start listening for real-time updates ──
  window.joinRoom = function (roomId) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    window.currentRoomId = roomId;
    localStorage.setItem('bp_room', roomId);

    const colRef = db.collection('rooms').doc(roomId).collection('portfolios');

    unsubscribe = colRef.onSnapshot(
      snapshot => {
        // Rebuild state.portfolios from Firestore
        state.portfolios = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Refresh whichever page is currently visible
        const activePage = document
          .querySelector('.page.active')?.id?.replace('page-', '');
        if (activePage) navigate(activePage);
      },
      err => {
        console.error('Firestore snapshot error:', err);
        toast('שגיאת סנכרון — בדוק חיבור אינטרנט', 'error');
      }
    );
  };

  // ── Detach listener ──
  window.leaveRoom = function () {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    window.currentRoomId = null;
  };

  // ── Write a portfolio document (add or overwrite) ──
  window.syncPortfolioSave = function (portfolio) {
    const roomId = window.currentRoomId;
    if (!roomId) return;
    db.collection('rooms').doc(roomId).collection('portfolios')
      .doc(portfolio.id)
      .set(portfolio)
      .catch(err => toast('שגיאה בשמירה: ' + err.message, 'error'));
  };

  // ── Delete a portfolio document ──
  window.syncPortfolioDelete = function (portfolioId) {
    const roomId = window.currentRoomId;
    if (!roomId) return;
    db.collection('rooms').doc(roomId).collection('portfolios')
      .doc(portfolioId)
      .delete()
      .catch(err => toast('שגיאה במחיקה: ' + err.message, 'error'));
  };
})();
