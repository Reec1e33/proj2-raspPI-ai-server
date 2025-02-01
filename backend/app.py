# backend/app.py
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from flask import Flask, jsonify, request
from monitor.sensors import collect_all_data
from monitor.ai_inference import load_tflite_model, run_inference

app = Flask(__name__)

# Pre-load model if you want a single global interpreter
MODEL_PATH = os.path.join(os.path.dirname(__file__), "placeholder_model.tflite")
INTERPRETER = None

@app.before_first_request
def init_model():
    global INTERPRETER
    if os.path.exists(MODEL_PATH):
        INTERPRETER = load_tflite_model(MODEL_PATH)
    else:
        print("Warning: TFLite model not found, anomaly detection will be unavailable.")

@app.route("/")
def home():
    return jsonify({"message": "Welcome to the AI Home Server API!"})

@app.route("/metrics")
def metrics():
    data = collect_all_data()
    return jsonify(data)

@app.route("/inference", methods=["GET"])
def inference():
    value = request.args.get("value", type=float, default=None)
    if value is None:
        sensor_data = collect_all_data()
        value = sensor_data["sensor_temp"]

    if not INTERPRETER:
        # Return a dummy inference response for testing purposes.
        return jsonify({
            "value_tested": value,
            "anomaly_score": 0.0,
            "is_anomaly": False,
            "warning": "Model not loaded, using dummy inference."
        })

    output = run_inference(INTERPRETER, value)
    anomaly_score = float(output[0][0])
    is_anomaly = anomaly_score > 0.5

    return jsonify({
        "value_tested": value,
        "anomaly_score": anomaly_score,
        "is_anomaly": is_anomaly
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
