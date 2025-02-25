import React, { useEffect, useState } from "react";
import axios from "axios";
import { Line } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from "chart.js";

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const Dashboard = () => {
  const [metrics, setMetrics] = useState([]);
  const [timestamps, setTimestamps] = useState([]);
  
  const fetchMetrics = async () => {
    try {
      const response = await axios.get("http://cloudserverreec1e33.ddns.net:5000/metrics");
      const data = response.data;
      setMetrics((prevMetrics) => [...prevMetrics, data]);
      setTimestamps((prevTimestamps) => [...prevTimestamps, new Date().toLocaleTimeString()]);
    } catch (error) {
      console.error("Error fetching metrics:", error);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000); // Fetch every 5 seconds
    return () => clearInterval(interval);
  }, []);

  // Prepare chart data
  const chartData = {
    labels: timestamps,
    datasets
