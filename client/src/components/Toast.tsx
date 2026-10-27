import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface ToastProps {
  message: string | null;
  type?: 'info' | 'success' | 'error';
  onDismiss: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type = 'info', onDismiss }) => {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      onDismiss();
    }, 4000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          className={`toast-container toast-${type}`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.2 }}
        >
          <span>{message}</span>
          <button onClick={onDismiss} className="toast-close" aria-label="Dismiss toast">
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
