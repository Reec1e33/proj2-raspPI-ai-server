# **proj2-raspPI-ai-server**

## **Overview**
This project is an **AI-powered home server** running on a **Raspberry Pi**, with a **web dashboard** for real-time monitoring of system metrics. The backend is built with **Flask**, while the frontend is developed in **React** to visualize system stats via graphs.

It includes:
- **Live Monitoring** of CPU temperature, disk usage, and sensor data.
- **Web Dashboard** for real-time metric visualization.
- **Domain Setup** with a **No-IP dynamic DNS** for remote access.
- **Docker/Kubernetes (Optional)** for future scalable deployments.
- **Security Configurations** to keep the server accessible but protected.

---

## **Features**
1. **Monitoring System Metrics**  
   - Collects CPU temperature, disk usage, and optional IoT sensor readings.
   - Uses Flask API to serve real-time system metrics.

2. **Web-Based Dashboard**  
   - Built with **React** + **Chart.js** for real-time visualization.
   - Fetches and displays system stats using **Axios**.

3. **Remote Access via Dynamic DNS**  
   - Configured with **No-IP (cloudserverreec1e33.ddns.net)** for external access.
   - Flask backend listens on port **5000**.

4. **Containerization & Future Scalability**  
   - Uses **Docker** for isolated deployment.
   - Can be extended with **Kubernetes (K3s)** for clustering.

---

## **Domain Setup (No-IP)**
Since your Raspberry Pi’s public IP changes, you set up **No-IP Dynamic DNS** to always access the server via a fixed domain.  

1. **Sign up for No-IP**:  
   - Registered `cloudserverreec1e33.ddns.net`
   - Installed `noip2` client on Raspberry Pi.

2. **Configure No-IP on the Raspberry Pi**:
   ```bash
   sudo apt install noip2
   sudo noip2 -C  # Configure with No-IP credentials
   ```

3. **Verify No-IP is Running**:
   ```bash
   noip2 -S
   ```

4. **Now, your Flask API is accessible at**:  
   ```
   http://cloudserverreec1e33.ddns.net:5000/metrics
   ```

---

## **Repository Structure**

```bash
proj2-raspPI-ai-server/
├── README.md                # Project overview & setup
├── backend/                 # Flask backend
│   ├── app.py               # Main Flask app
│   ├── requirements.txt     # Python dependencies
│   └── monitor/
│       ├── sensors.py       # Sensor data collection
├── frontend/                # React web dashboard
│   ├── package.json         # Frontend dependencies
│   ├── src/
│   │   ├── App.js           # Main React component
│   │   ├── Dashboard.js     # Dashboard UI
│   │   └── index.js
├── docker/                  # Docker setup
│   ├── Dockerfile.backend   # Docker config for Flask
│   ├── Dockerfile.frontend  # Docker config for React
├── k8s/                     # Kubernetes setup (if used)
│   ├── deployment-backend.yaml
│   ├── service-backend.yaml
└── .github/workflows/       # CI/CD Pipelines
    └── ci.yml
```

---

## **Backend Deployment (Flask)**
Your Flask API is responsible for gathering system metrics and serving them via REST endpoints.

### **1. Run Locally**
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```
**API Endpoints**:
- `GET /metrics` → Returns CPU temp, disk usage, sensor data.

### **2. Run with Docker**
```bash
cd backend
docker build -t ai-backend .
docker run -d -p 5000:5000 ai-backend
```

---

## **Frontend Deployment (React)**
Your **React dashboard** fetches system stats and displays them in **charts**.

### **1. Run Locally**
```bash
cd frontend
npm install
npm start
```
- Accessible at: **`http://localhost:3000`**

### **2. Run with Docker**
```bash
cd frontend
docker build -t ai-frontend .
docker run -d -p 3000:3000 ai-frontend
```

---

## **Accessing the Dashboard**
Once everything is running, visit:

```
http://cloudserverreec1e33.ddns.net:3000
```
*(Replace with your actual No-IP domain if needed.)*



