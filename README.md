# proj2-raspPI-ai-server


## Overview
This repository contains all the source code, documentation, and configuration files required to build and deploy an **AI-Powered Home Server with a Cloud Dashboard** on a Raspberry Pi. The project integrates:
- **Real-Time Monitoring** of system metrics and optional IoT sensors
- **Machine Learning (ML)** for anomaly detection
- **Full-Stack Web Dashboard** for live data visualization
- **DevOps Tooling** (Docker, K3s) for scalable deployments
- **Security** (VPN, firewall, IDS)
- **Cloud Integration** (AWS/GCP) for data storage and alerting

## Features
1. **Monitoring & Data Collection**  
   - CPU temperature, disk usage, network traffic, and additional IoT sensors.

2. **AI/ML Anomaly Detection**  
   - TensorFlow Lite for predictive modeling or OpenCV for motion detection.

3. **RESTful or GraphQL API**  
   - Built with Flask/FastAPI to expose data and AI insights.

4. **Front-End Dashboard**  
   - React.js or Vue.js for real-time charts, alerts, and data streaming.

5. **Secure Deployment & Infrastructure**  
   - Docker containers, lightweight Kubernetes (k3s), and GitHub Actions for CI/CD.
   - WireGuard VPN, firewall rules, and optional Suricata IDS.

6. **Cloud Storage & Alerts**  
   - Automatic backups to AWS S3 (or GCP), and alert notifications (SNS, email, etc.).

## Repository Structure

```bash
proj2-raspPI-ai-server/
├─ README.md                # Project overview and instructions
├─ docs/                    # Additional documentation
│   ├─ pi-setup.md          # Steps for Raspberry Pi setup
│   ├─ ai-setup.md          # ML/AI installation & usage
│   ├─ database.md          # Database config (PostgreSQL/MongoDB)
│   └─ ...
├─ monitor/                 # Scripts for system/IoT sensor monitoring
│   └─ sensors.py
├─ backend/                 # Flask or FastAPI application
│   ├─ app.py
│   ├─ requirements.txt
│   └─ ...
├─ frontend/                # React or Vue app
│   ├─ package.json
│   └─ src/
├─ docker/                  # Dockerfiles for backend/frontend
│   ├─ Dockerfile.backend
│   └─ Dockerfile.frontend
├─ k8s/                     # Kubernetes deployment & service manifests
│   ├─ deployment-backend.yaml
│   └─ ...
└─ .github/workflows/       # GitHub Actions CI/CD pipelines
    └─ ci.yml
## Deployment

### Frontend
1. Build the image:
   ```bash
   docker build -t reec1e33/ai-frontend:latest -f docker/Dockerfile.frontend .
