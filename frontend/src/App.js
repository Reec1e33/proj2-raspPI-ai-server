import React, { useState, useEffect } from 'react';
import axios from 'axios';

function App() {
  const [metrics, setMetrics] = useState({});
  const [inference, setInference] = useState(null);

  useEffect(() => {
    // Fetch metrics every few seconds
    const fetchMetrics = async () => {
      try {
        const res = await axios.get('/metrics'); // Adjust baseURL or proxy if needed
        setMetrics(res.data);
      } catch (err) {
        console.error(err);
      }
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCheckAnomaly = async () => {
    try {
      // We'll pass sensor_temp as query param
      if (metrics.sensor_temp !== undefined) {
        const res = await axios.get(`/inference?value=${metrics.sensor_temp}`);
        setInference(res.data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{padding: '1rem'}}>
      <h1>AI Home Server Dashboard</h1>
      <h2>Metrics</h2>
      <ul>
        <li>CPU Temp: {metrics.cpu_temp} °C</li>
        <li>Disk Usage: {metrics.disk_usage} %</li>
        <li>Sensor Temp: {metrics.sensor_temp} °C</li>
      </ul>
      <button onClick={handleCheckAnomaly}>Check Anomaly</button>
      {inference && (
        <div>
          <h2>Anomaly Check</h2>
          <p>Value Tested: {inference.value_tested}</p>
          <p>Anomaly Score: {inference.anomaly_score}</p>
          <p>Is Anomaly: {inference.is_anomaly ? 'Yes' : 'No'}</p>
        </div>
      )}
    </div>
  );
}

export default App;
