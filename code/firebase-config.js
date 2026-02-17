const firebaseConfig = {
  apiKey: "AIzaSyCICAOcFwbYhdoSU2uYZ93jf9kufRQNtxI",
  authDomain: "del-be-del-demo.firebaseapp.com",
  projectId: "del-be-del-demo",
  storageBucket: "del-be-del-demo.firebasestorage.app",
  messagingSenderId: "61151151145",
  appId: "1:61151151145:web:6ccf5a5f15414032300838"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
