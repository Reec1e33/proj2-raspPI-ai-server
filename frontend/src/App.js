import React, { useEffect, useState } from "react";
import axios from "axios";
import { Line } from "react-chartjs-2";
import "chart.js/auto";

const API_URL = "http://cloudserverreec1e33.ddns.net:5000/metrics"; // Update with No-IP

function App() {
  const [labels, setLabels] = useState([]);
  const [cpuTemps, setCpuTemps] = useState([]);
  const [cpuUsage, setCpuUsage] = useState([]);
  const [memoryUsage, setMemoryUsage] = useState([]);
  const [diskUsage, setDiskUsage] = useState([]);
  const [networkSent, setNetworkSent] = useState([]);
  const [networkRecv, setNetworkRecv] = useState([]);
  const [sensorTemps, setSensorTemps] = useState([]);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await axios.get(API_URL);
        const data = response.data;

        setLabels((prev) => [...prev, new Date().toLocaleTimeString()]);
        setCpuTemps((prev) => [...prev, data.cpu_temp]);
        setCpuUsage((prev) => [...prev, data.cpu_usage]);
        setMemoryUsage((prev) => [...prev, data.memory_usage]);
        setDiskUsage((prev) => [...prev, data.disk_usage]);
        setNetworkSent((prev) => [...prev, data.network.bytes_sent]);
        setNetworkRecv((prev) => [...prev, data.network.bytes_recv]);
        setSensorTemps((prev) => [...prev, data.sensor_temp]);
      } catch (error) {
        console.error("Error fetching metrics:", error);
      }
    };

    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  const data = {
    labels: labels,
    datasets: [
      { label: "CPU Temp (°C)", data: cpuTemps, borderColor: "red", fill: false },
      { label: "CPU Usage (%)", data: cpuUsage, borderColor: "orange", fill: false },
      { label: "Memory Usage (%)", data: memoryUsage, borderColor: "purple", fill: false },
      { label: "Disk Usage (%)", data: diskUsage, borderColor: "blue", fill: false },
      { label: "Network Sent (MB)", data: networkSent, borderColor: "pink", fill: false },
      { label: "Network Received (MB)", data: networkRecv, borderColor: "cyan", fill: false },
      { label: "Sensor Temp (°C)", data: sensorTemps, borderColor: "green", fill: false },
    ],
  };

  return (
    <div style={{ textAlign: "center" }}>
      <h1>Raspberry Pi System Monitor</h1>
      <Line data={data} />
    </div>
  );
}

export default App;
